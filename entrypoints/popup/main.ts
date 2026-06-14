// Action popup — the tray UI.
// Clicking the toolbar icon opens this popup directly (records first, screen
// capture one click away). Renders TrayItems from IndexedDB, supports search,
// multi-select, add-link/add-note/add-code, delete, and "send to <target>"
// (delegated to the background, which owns tab orchestration). Re-renders on
// TRAY_UPDATED broadcasts from the editor.
//
// The only capture entry here is "开始截图（整个屏幕）" -> REQUEST_SCREEN_CAPTURE;
// all framing/annotation/longshot live in the native overlay toolbar.
//
// One popup-specific constraint: window.prompt/alert/confirm are DISABLED
// inside extension popups, so note input goes through the inline composer.

import { TRAY_TTL_MS } from '@/shared/config';
import { deleteTrayItem, listTrayItems, putTrayItem, sweepStore } from '@/shared/db';
import { HOTKEY_ERROR_KEY } from '@/shared/native';
import {
  DEFAULT_HOTKEY,
  HOTKEY_KEY,
  formatHotkey,
  hotkeyFromEvent,
  isValidHotkey,
  type Hotkey,
} from '@/shared/hotkey';
import { TARGETS, isTargetId, type TargetId } from '@/shared/targets';
import { currentTheme, initTheme, toggleTheme } from '@/shared/theme';
import type { Msg, MsgResponse, TrayItem } from '@/shared/types';
import { uid } from '@/shared/types';

const TARGET_PREF_KEY = 'shotcache.target';

const listEl = document.getElementById('list') as HTMLUListElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;
const searchEl = document.getElementById('search') as HTMLInputElement;
const selectAllEl = document.getElementById('select-all') as HTMLInputElement;
const targetEl = document.getElementById('target') as HTMLSelectElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;
const composerEl = document.getElementById('composer') as HTMLDivElement;
const composerText = document.getElementById('composer-text') as HTMLTextAreaElement;

let composerKind: 'text' | 'code' = 'text';

const selected = new Set<string>();
let visible: TrayItem[] = [];

browser.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === 'TRAY_UPDATED') void render();
});

// --- capture entries ---

document.getElementById('capture-screen')!.addEventListener('click', async () => {
  const res = (await browser.runtime.sendMessage({
    type: 'REQUEST_SCREEN_CAPTURE',
  } satisfies Msg)) as MsgResponse;
  if (!res.ok) return toast(`无法发起全屏截图：${res.error ?? '未知错误'}`);
  // Close so the screen picker is front and center; the flow continues in
  // the background worker either way.
  window.close();
});

// --- add items ---

document.getElementById('add-tab')!.addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return toast('未找到当前标签页');
  await putTrayItem({
    id: uid(),
    kind: 'link',
    createdAt: Date.now(),
    title: tab.title ?? tab.url,
    sourceUrl: tab.url,
    text: tab.url,
  });
  await render();
});

document.getElementById('add-note')!.addEventListener('click', () => openComposer('text'));
document.getElementById('add-code')!.addEventListener('click', () => openComposer('code'));

document.getElementById('composer-cancel')!.addEventListener('click', () => closeComposer());

document.getElementById('composer-save')!.addEventListener('click', async () => {
  const text = composerText.value.trim();
  if (!text) return closeComposer(); // empty input -> just dismiss
  // Code titles read better as the first line; notes as the leading chars.
  const title =
    composerKind === 'code' ? (text.split('\n')[0] ?? '').slice(0, 30) : text.slice(0, 30);
  await putTrayItem({ id: uid(), kind: composerKind, createdAt: Date.now(), title, text });
  closeComposer();
  await render();
});

function openComposer(kind: 'text' | 'code'): void {
  composerKind = kind;
  panelEl.hidden = true; // don't stack the settings panel under the composer
  composerEl.hidden = false;
  composerEl.classList.toggle('code', kind === 'code');
  composerText.placeholder = kind === 'code' ? '粘贴代码…' : '备注内容…';
  composerText.value = '';
  composerText.focus();
}

function closeComposer(): void {
  composerEl.hidden = true;
  composerText.value = '';
}

// --- delete / send ---

document.getElementById('delete')!.addEventListener('click', async () => {
  if (selected.size === 0) return toast('先勾选要删除的条目');
  for (const id of selected) await deleteTrayItem(id);
  selected.clear();
  await render();
});

sendEl.addEventListener('click', async () => {
  if (selected.size === 0) return toast('先勾选要发送的条目');
  const target = currentTarget();
  toast(`正在发送到 ${TARGETS[target].label}…`);
  const res = (await browser.runtime.sendMessage({
    type: 'SEND_ITEMS',
    target,
    itemIds: [...selected],
  } satisfies Msg)) as MsgResponse;
  toast(res.ok ? `已注入到 ${TARGETS[target].label} 输入框` : `发送失败：${res.error ?? '未知错误'}`);
});

// --- theme ---

const themeEl = document.getElementById('theme') as HTMLButtonElement;
function paintThemeButton(): void {
  const dark = currentTheme() === 'dark';
  themeEl.textContent = dark ? '🌙' : '☀️';
  themeEl.title = dark ? '当前深色，点击切换浅色' : '当前浅色，点击切换深色';
}
themeEl.addEventListener('click', () => {
  toggleTheme();
  paintThemeButton();
});

// --- settings: global capture hotkey ---

const panelEl = document.getElementById('settings-panel') as HTMLDivElement;
const hkBtn = document.getElementById('hk-record') as HTMLButtonElement;
const hkHint = document.getElementById('hk-hint') as HTMLDivElement;
const hkSave = document.getElementById('hk-save') as HTMLButtonElement;

const HK_PROMPT = '点按钮后按下组合键（需含 Ctrl / Alt / Win + 一个主键）。';
let savedHotkey: Hotkey = DEFAULT_HOTKEY;
let pendingHotkey: Hotkey = DEFAULT_HOTKEY;
let recording = false;

document.getElementById('settings')!.addEventListener('click', () => {
  panelEl.hidden = !panelEl.hidden;
  if (!panelEl.hidden) closeComposer();
  if (recording) stopRecording();
});

async function loadHotkey(): Promise<void> {
  const stored = (await browser.storage.local.get(HOTKEY_KEY))[HOTKEY_KEY] as Hotkey | undefined;
  savedHotkey = stored ?? DEFAULT_HOTKEY;
  pendingHotkey = savedHotkey;
  hkBtn.textContent = formatHotkey(savedHotkey);
}

function setHint(text: string, err = false): void {
  hkHint.textContent = text;
  hkHint.classList.toggle('err', err);
}

function stopRecording(): void {
  recording = false;
  hkBtn.classList.remove('recording');
  hkBtn.textContent = formatHotkey(pendingHotkey);
  setHint(HK_PROMPT);
}

hkBtn.addEventListener('click', () => {
  recording = true;
  hkBtn.classList.add('recording');
  hkBtn.textContent = '按下组合键…';
  setHint('按下含 Ctrl / Alt / Win 的组合，Esc 取消录制。');
});

// Capture-phase so the combo never leaks to the search box etc.
document.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopRecording();
    const hk = hotkeyFromEvent(e);
    if (!hk) return; // lone modifier / unsupported key — keep waiting
    pendingHotkey = hk;
    recording = false;
    hkBtn.classList.remove('recording');
    hkBtn.textContent = formatHotkey(hk);
    if (isValidHotkey(hk)) setHint(`将设为 ${formatHotkey(hk)}，点「保存」生效。`);
    else setHint('至少要含一个 Ctrl / Alt / Win 修饰键。', true);
  },
  true,
);

document.getElementById('hk-reset')!.addEventListener('click', () => {
  pendingHotkey = DEFAULT_HOTKEY;
  hkBtn.textContent = formatHotkey(DEFAULT_HOTKEY);
  void saveHotkey();
});

hkSave.addEventListener('click', () => void saveHotkey());

async function saveHotkey(): Promise<void> {
  if (recording) stopRecording();
  if (!isValidHotkey(pendingHotkey)) {
    setHint('快捷键无效：至少一个 Ctrl / Alt / Win + 一个主键。', true);
    return;
  }
  hkSave.disabled = true;
  const res = (await browser.runtime.sendMessage({
    type: 'SET_HOTKEY',
    hotkey: pendingHotkey,
  } satisfies Msg)) as MsgResponse;
  hkSave.disabled = false;
  if (!res.ok) return setHint(res.error ?? '设置失败', true);
  savedHotkey = pendingHotkey;
  setHint(
    res.pending
      ? `已保存 ${formatHotkey(savedHotkey)}，桌面组件连接后生效。`
      : `✓ 已生效：${formatHotkey(savedHotkey)}`,
  );
}

document.getElementById('open-chrome-shortcuts')!.addEventListener('click', () => {
  void browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

searchEl.addEventListener('input', () => void render());

selectAllEl.addEventListener('change', () => {
  // "Select all" applies to the items the user can currently see (filtered).
  selected.clear();
  if (selectAllEl.checked) visible.forEach((i) => selected.add(i.id));
  void render();
});

// --- send target ---

function initTargetSelect(): void {
  for (const [id, t] of Object.entries(TARGETS)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = t.label;
    targetEl.append(opt);
  }
  const saved = localStorage.getItem(TARGET_PREF_KEY);
  if (saved && isTargetId(saved)) targetEl.value = saved;
  updateSendLabel();
  targetEl.addEventListener('change', () => {
    localStorage.setItem(TARGET_PREF_KEY, targetEl.value);
    updateSendLabel();
  });
}

const currentTarget = (): TargetId => (isTargetId(targetEl.value) ? targetEl.value : 'claude');

const updateSendLabel = () => (sendEl.textContent = `发送到 ${TARGETS[currentTarget()].label}`);

// --- rendering ---

async function render(): Promise<void> {
  const items = await listTrayItems();
  const q = searchEl.value.trim().toLowerCase();
  visible = q
    ? items.filter((i) =>
        [i.title, i.text, i.sourceUrl].some((f) => f?.toLowerCase().includes(q)),
      )
    : items;

  emptyEl.hidden = items.length > 0;
  listEl.replaceChildren(...visible.map(renderItem));
  selectAllEl.checked = visible.length > 0 && visible.every((i) => selected.has(i.id));
}

function renderItem(item: TrayItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `item${selected.has(item.id) ? ' checked' : ''}`;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selected.has(item.id);
  cb.addEventListener('change', () => {
    cb.checked ? selected.add(item.id) : selected.delete(item.id);
    li.classList.toggle('checked', cb.checked);
  });

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'title';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = { image: '图', text: '文', link: '链', code: '码' }[item.kind];
  title.append(kind, document.createTextNode(item.title));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${new Date(item.createdAt).toLocaleString()} · ${daysLeft(item)}天后清理`;

  body.append(title, meta);

  if (item.kind === 'image' && item.thumb) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = item.thumb;
    img.alt = item.title;
    img.title = '点击查看原图';
    img.addEventListener('click', () => openFullImage(item));
    body.append(img);
  } else if (item.text) {
    const p = document.createElement('div');
    p.className = item.kind === 'code' ? 'preview code' : 'preview';
    p.textContent = item.text;
    body.append(p);
  }

  li.append(cb, body);
  return li;
}

function daysLeft(item: TrayItem): number {
  return Math.max(0, Math.ceil((item.createdAt + TRAY_TTL_MS - Date.now()) / 86_400_000));
}

function openFullImage(item: TrayItem): void {
  if (!item.blob) return;
  const url = URL.createObjectURL(item.blob);
  void browser.tabs.create({ url }).catch(() => toast('无法打开原图'));
  // Keep the URL alive long enough for the tab to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

// --- boot --- (kept last: everything above, including const arrow helpers,
// must be initialized before these run — calling earlier hits the TDZ)

initTheme();
paintThemeButton();
void loadHotkey();
initTargetSelect();
// Sweep expired items before first paint so the user never sees one that the
// background alarm hasn't gotten to yet.
void sweepStore('tray', TRAY_TTL_MS).then(() => render());
// Surface a host-side hotkey registration failure (set by the background on
// `hotkey-failed`, cleared on every successful hello).
void browser.storage.local.get(HOTKEY_ERROR_KEY).then((r) => {
  const msg = r[HOTKEY_ERROR_KEY];
  if (typeof msg === 'string' && msg) {
    const warn = document.getElementById('warn')!;
    warn.textContent = `⚠ 全局热键不可用：${msg}。仍可从此处的「⛶ 开始截图」截屏。`;
    warn.hidden = false;
  }
});
