// Background service worker.
// Responsibilities:
//  1. capture-screen command (Alt+Shift+F) / REQUEST_SCREEN_CAPTURE (popup
//     button) -> whole-desktop capture. Preferred: the native companion host
//     (native-host/) grabs the screen as-is — silent, no picker, WeChat-style,
//     and its overlay owns framing/annotation/longshot, depositing the result
//     straight into the tray. Fallback when the host is not installed:
//     select.html in pick mode hosts Chrome's screen picker AND consumes the
//     stream itself (a desktopCapture streamId is bound to the requesting page
//     — neither this worker nor an offscreen document may getUserMedia with
//     it); we minimize/restore its window around the grab (HIDE_WINDOW /
//     RESTORE_WINDOW), then crop in the editor.
//  2. On SEND_ITEMS: serialize tray items, find/create a tab for the chosen
//     target (Claude/ChatGPT/Gemini), hand items to that site's injector.
//  3. Expiry GC: sweep stale tray items + pending captures on every worker
//     start and on a periodic alarm. (A plain setTimeout would die with the
//     service worker — MV3 workers are killed after ~30s idle.)
//
// Capture is whole-screen only; there is no page injection on the capture path,
// so no activeTab/scripting/<all_urls> — just nativeMessaging + desktopCapture.

import { PENDING_TTL_MS, TRAY_TTL_MS } from '@/shared/config';
import { getTrayItem, putPending, putTrayItem, sweepStore } from '@/shared/db';
import { HOTKEY_KEY, formatHotkey, toWin32, type Hotkey } from '@/shared/hotkey';
import {
  EMOJIS,
  HOTKEY_ERROR_KEY,
  NATIVE_HOST_NAME,
  type NativeCmd,
  type NativeInMsg,
} from '@/shared/native';
import { TARGETS, type TargetId } from '@/shared/targets';
import type { Msg, MsgResponse, PendingCapture, WireItem } from '@/shared/types';
import { uid } from '@/shared/types';

const GC_ALARM = 'shotcache-gc';
/** Give the just-closed popup a beat to vanish before the native grab. */
const POPUP_VANISH_MS = 300;
/** One-shot inactivity timeout. Must exceed the v2 host's 20s ping interval —
 *  the user may sit in the overlay indefinitely, with only pings arriving. */
const NATIVE_TIMEOUT_MS = 30_000;

export default defineBackground(() => {
  runGc();
  connectHost();
  browser.alarms.create(GC_ALARM, { periodInMinutes: 6 * 60 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === GC_ALARM) runGc();
  });
  void browser.action.setBadgeBackgroundColor({ color: '#e5534b' }).catch(() => {});

  browser.commands.onCommand.addListener((command) => {
    if (command === 'capture-screen') void startScreenCaptureFlow(0);
  });

  browser.runtime.onMessage.addListener(
    (msg: Msg, sender, sendResponse: (r: MsgResponse) => void) => {
      switch (msg.type) {
        case 'SEND_ITEMS':
          sendItems(msg.target, msg.itemIds)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => {
              console.error('[shotcache] send failed', e);
              sendResponse({ ok: false, error: String(e) });
            });
          return true;
        case 'REQUEST_SCREEN_CAPTURE':
          // Fire-and-forget; the popup closes itself right after this reply,
          // and the flow waits POPUP_VANISH_MS so it is not in the shot.
          void startScreenCaptureFlow(POPUP_VANISH_MS);
          sendResponse({ ok: true });
          return;
        case 'SET_HOTKEY': {
          const w = toWin32(msg.hotkey);
          if (!w) {
            sendResponse({ ok: false, error: '快捷键无效：至少一个 Ctrl/Alt/Win + 一个主键' });
            return;
          }
          // Storage is the source of truth — persist regardless of host state.
          void browser.storage.local.set({ [HOTKEY_KEY]: msg.hotkey }).catch(() => {});
          if (portState !== 'ready' || !nativePort) {
            sendResponse({ ok: true, pending: true }); // applies on next host connect
            return;
          }
          // Reply only once the host confirms (or after a short fallback).
          if (pendingHotkeyResolve) pendingHotkeyResolve({ ok: true, pending: true });
          clearTimeout(pendingHotkeyTimer);
          pendingHotkeyResolve = sendResponse;
          pendingHotkeyTimer = setTimeout(() => {
            if (pendingHotkeyResolve === sendResponse) {
              sendResponse({ ok: true, pending: true });
              pendingHotkeyResolve = null;
            }
          }, 4000);
          nativePort.postMessage({
            cmd: 'set-hotkey',
            mods: w.mods,
            vk: w.vk,
            label: formatHotkey(msg.hotkey),
          } satisfies NativeCmd);
          return true; // async response
        }
        case 'HIDE_WINDOW': {
          hideWindow(sender.tab?.windowId)
            .then((prevState) => sendResponse({ ok: true, windowState: prevState }))
            .catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true; // async response
        }
        case 'RESTORE_WINDOW':
          void restoreWindow(sender.tab?.windowId, msg.prevState);
          sendResponse({ ok: true });
          return;
      }
    },
  );
});

function runGc(): void {
  void sweepStore('tray', TRAY_TTL_MS).catch(() => {});
  void sweepStore('pending', PENDING_TTL_MS).catch(() => {});
}

// ---------------------------------------------------------------------------
// Resident native host (protocol v2): persistent port + WeChat-style overlay
// ---------------------------------------------------------------------------
// The host owns the whole capture UX (freeze -> select -> annotate -> Enter);
// we receive the finished PNG over this port and save it straight into the
// tray — zero tabs. The host pings every 20s, which resets this worker's idle
// timer, so the port (and the host's global Ctrl+Alt+A) stays alive.

type PortState = 'down' | 'connecting' | 'ready' | 'legacy';

let nativePort: ReturnType<typeof browser.runtime.connectNative> | null = null;
let portState: PortState = 'down';
let reconnectDelay = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let inflightShot:
  | { width: number; height: number; total: number; chunks: string[]; edit?: boolean }
  | null = null;
// One in-flight SET_HOTKEY at a time: resolves the popup's response when the
// host's hotkey-set reply arrives (or a timeout falls back to "pending").
let pendingHotkeyResolve: ((r: MsgResponse) => void) | null = null;
let pendingHotkeyTimer: ReturnType<typeof setTimeout> | undefined;

function connectHost(): void {
  if (portState === 'legacy' || nativePort) return;
  try {
    nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    console.warn('[shotcache] connectNative threw', e);
    scheduleReconnect();
    return;
  }
  portState = 'connecting';
  nativePort.onMessage.addListener(onNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    // Not installed / killed / Chrome shutting down. lastError must be read
    // to keep the console clean.
    void browser.runtime.lastError;
    nativePort = null;
    inflightShot = null;
    if (portState !== 'legacy') {
      portState = 'down';
      scheduleReconnect();
    }
  });
  nativePort.postMessage({ cmd: 'hello' } satisfies NativeCmd);
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectHost, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
}

function onNativeMessage(raw: unknown): void {
  const m = raw as NativeInMsg;

  if (portState === 'connecting') {
    if (m.type === 'ping') return;
    if (m.type === 'hello' && m.version >= 2) {
      portState = 'ready';
      reconnectDelay = 1_000;
      // A fresh hello means the hotkey either registered fine or a
      // hotkey-failed message is right behind this one.
      void browser.storage.local.remove(HOTKEY_ERROR_KEY).catch(() => {});
      // Re-apply the user's chosen hotkey (if any) — storage is the source of
      // truth; the host only keeps a boot-time cache.
      void pushStoredHotkey();
      // GDI+ cannot rasterize color fonts — ship the emoji glyphs rendered
      // by Chrome so the overlay's emoji tool is colored.
      void sendEmojiSheet().catch((e) => console.warn('[shotcache] emoji sheet failed', e));
      return;
    }
    // A v1 host answers hello with "unknown command": one-shot legacy mode.
    // Stay off the persistent port; captures use captureViaNativeOneShot.
    portState = 'legacy';
    nativePort?.disconnect();
    nativePort = null;
    console.warn('[shotcache] native host is v1 — rerun native-host/install.ps1 to upgrade');
    return;
  }

  switch (m.type) {
    case 'ping':
      return;
    case 'shot-meta':
      inflightShot = { width: m.width, height: m.height, total: m.chunks, chunks: [], edit: m.edit };
      return;
    case 'shot-chunk':
      if (inflightShot && m.seq != null) inflightShot.chunks[m.seq] = m.data;
      return;
    case 'shot-done': {
      const shot = inflightShot;
      inflightShot = null;
      if (!shot) return;
      for (let i = 0; i < shot.total; i++) {
        if (typeof shot.chunks[i] !== 'string') {
          console.warn(`[shotcache] shot dropped: missing chunk ${i}`);
          flashGlobalBadge('✕');
          return; // the host already copied it to the clipboard — nothing lost
        }
      }
      {
        const b64 = shot.chunks.join('');
        // Longshots arrive unannotated — open them in the editor (like a page
        // capture) instead of dropping them straight into the tray.
        const done = shot.edit ? openLongshotEditor(b64, shot.width, shot.height) : saveScreenshotToTray(b64);
        done.catch((e) => {
          console.error('[shotcache] shot finalize failed', e);
          flashGlobalBadge('✕');
        });
      }
      return;
    }
    case 'cancelled':
      return; // user pressed Esc in the overlay — not an error
    case 'error':
      console.warn('[shotcache] native capture error:', m.message);
      flashGlobalBadge('✕');
      return;
    case 'hotkey-failed':
      void browser.storage.local
        .set({ [HOTKEY_ERROR_KEY]: m.message ?? 'Ctrl+Alt+A 注册失败' })
        .catch(() => {});
      return;
    case 'hotkey-set':
      if (m.ok) void browser.storage.local.remove(HOTKEY_ERROR_KEY).catch(() => {});
      else
        void browser.storage.local
          .set({ [HOTKEY_ERROR_KEY]: m.message ?? '快捷键注册失败' })
          .catch(() => {});
      if (pendingHotkeyResolve) {
        clearTimeout(pendingHotkeyTimer);
        pendingHotkeyResolve({ ok: m.ok, error: m.ok ? undefined : m.message ?? '快捷键注册失败' });
        pendingHotkeyResolve = null;
      }
      return;
  }
}

/** Push the stored hotkey to the host (no-op if none stored or port down). */
async function pushStoredHotkey(): Promise<void> {
  if (portState !== 'ready' || !nativePort) return;
  const got = (await browser.storage.local
    .get(HOTKEY_KEY)
    .catch(() => ({}))) as Record<string, unknown>;
  const stored = got[HOTKEY_KEY] as Hotkey | undefined;
  if (!stored) return; // host falls back to its own default/cache
  const w = toWin32(stored);
  if (!w) return;
  nativePort.postMessage({
    cmd: 'set-hotkey',
    mods: w.mods,
    vk: w.vk,
    label: formatHotkey(stored),
  } satisfies NativeCmd);
}

/** Longshot (base64 PNG) -> pending capture -> open the editor for annotation,
 *  exactly like a page capture. The full image is the crop (rect = whole, dpr=1). */
async function openLongshotEditor(pngBase64: string, w: number, h: number): Promise<void> {
  const pending: PendingCapture = {
    id: uid(),
    createdAt: Date.now(),
    dataUrl: `data:image/png;base64,${pngBase64}`,
    rect: { x: 0, y: 0, w, h },
    dpr: 1,
    sourceUrl: '',
    sourceTitle: '长截图',
  };
  await putPending(pending);
  await browser.tabs.create({ url: browser.runtime.getURL(`/editor.html?capture=${pending.id}`) });
}

/** Finished overlay capture (base64 PNG) -> tray item with thumbnail. */
async function saveScreenshotToTray(pngBase64: string): Promise<void> {
  const blob = base64ToBlob(pngBase64, 'image/png');
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 160 / bmp.width);
  const tw = Math.max(1, Math.round(bmp.width * scale));
  const th = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(tw, th);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, tw, th);
  bmp.close();
  const thumbBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const thumb = `data:image/jpeg;base64,${await blobToBase64(thumbBlob)}`;

  await putTrayItem({
    id: uid(),
    kind: 'image',
    createdAt: Date.now(),
    title: '屏幕截图',
    blob,
    thumb,
  });
  void browser.runtime.sendMessage({ type: 'TRAY_UPDATED' } satisfies Msg).catch(() => {});
  flashGlobalBadge('✓', '#2ea043');
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Render the annotation emoji set on a canvas (Chrome's text stack does
 *  color emoji; GDI+ in the host cannot) and ship it over the port. Glyphs
 *  that rasterize to nothing (missing font) are skipped — the host then
 *  falls back to a monochrome outline for those. */
async function sendEmojiSheet(): Promise<void> {
  if (!nativePort) return;
  const SIZE = 64;
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const entries: { ch: string; data: string }[] = [];
  for (const ch of EMOJIS) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.font = `${Math.round(SIZE * 0.78)}px "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, SIZE / 2, SIZE / 2 + 2);
    const alpha = ctx.getImageData(0, 0, SIZE, SIZE).data.some((v, i) => i % 4 === 3 && v > 0);
    if (!alpha) continue;
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    entries.push({ ch, data: await blobToBase64(blob) });
  }
  if (entries.length > 0 && nativePort) {
    nativePort.postMessage({ cmd: 'emoji-sheet', size: SIZE, entries } satisfies NativeCmd);
  }
}

// ---------------------------------------------------------------------------
// Whole-desktop capture routing
// ---------------------------------------------------------------------------

/**
 * Preferred: ask the resident host over the persistent port — the WeChat
 * overlay handles everything and the result comes back via onNativeMessage.
 * Legacy v1 host: one-shot grab, then the select-page flow. No host at all:
 * the extension-only picker flow.
 */
async function startScreenCaptureFlow(delayMs: number): Promise<void> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

  if (portState === 'ready' && nativePort) {
    nativePort.postMessage({ cmd: 'capture' } satisfies NativeCmd);
    return;
  }

  try {
    const shot = await captureViaNativeOneShot();
    if (shot.final) {
      // A v2 host answered (port was only momentarily down): the overlay
      // already cropped and annotated — straight to the tray.
      await saveScreenshotToTray(shot.base64);
      return;
    }
    const pending: PendingCapture = {
      id: uid(),
      createdAt: Date.now(),
      dataUrl: `data:image/png;base64,${shot.base64}`,
      // Full frame in bitmap pixels (dpr=1); the select page narrows it.
      rect: { x: 0, y: 0, w: shot.width, h: shot.height },
      dpr: 1,
      sourceUrl: '',
      sourceTitle: '屏幕截图',
    };
    await putPending(pending);
    await browser.tabs.create({
      url: browser.runtime.getURL(`/select.html?capture=${pending.id}`),
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'cancelled') return; // user's Esc — not a failure
    console.warn('[shotcache] native capture unavailable, falling back to picker', e);
    await openScreenPicker();
  }
}

/**
 * One-shot capture for when the persistent port is not ready. Speaks BOTH
 * protocol generations: a v1 host replies meta/chunk/done with the raw frame
 * (`final: false` — the select page must crop it); a v2 host runs its overlay
 * and replies shot-meta/shot-chunk/shot-done with the finished image
 * (`final: true`). The inactivity timeout rolls on every message — a v2 user
 * may sit in the overlay for a while, but pings arrive every 20s.
 */
function captureViaNativeOneShot(): Promise<{
  base64: string;
  width: number;
  height: number;
  final: boolean;
}> {
  return new Promise((resolve, reject) => {
    const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    const chunks: string[] = [];
    let meta: { width: number; height: number; chunks: number; final: boolean } | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        port.disconnect();
        reject(new Error('Native host timed out'));
      }, NATIVE_TIMEOUT_MS);
    };
    armTimeout();

    port.onMessage.addListener((raw: unknown) => {
      const m = raw as {
        type: string;
        width?: number;
        height?: number;
        chunks?: number;
        seq?: number;
        data?: string;
        message?: string;
      };
      armTimeout();
      switch (m.type) {
        case 'ping':
          return; // v2 keepalive while its overlay is open
        case 'meta':
        case 'shot-meta':
          meta = {
            width: m.width ?? 0,
            height: m.height ?? 0,
            chunks: m.chunks ?? 0,
            final: m.type === 'shot-meta',
          };
          return;
        case 'chunk':
        case 'shot-chunk':
          if (m.seq != null && m.data != null) chunks[m.seq] = m.data;
          return;
        case 'done':
        case 'shot-done': {
          clearTimeout(timer);
          port.disconnect();
          if (!meta) return reject(new Error('Native host sent no metadata'));
          for (let i = 0; i < meta.chunks; i++) {
            if (typeof chunks[i] !== 'string') {
              return reject(new Error(`Missing chunk ${i} from native host`));
            }
          }
          resolve({
            base64: chunks.join(''),
            width: meta.width,
            height: meta.height,
            final: meta.final,
          });
          return;
        }
        case 'cancelled':
          clearTimeout(timer);
          port.disconnect();
          reject(new Error('cancelled'));
          return;
        case 'error':
          clearTimeout(timer);
          port.disconnect();
          reject(new Error(m.message ?? 'Native host error'));
          return;
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      // A settled promise ignores this; an early disconnect (host not
      // installed / killed) lands here with runtime.lastError set.
      reject(new Error(browser.runtime.lastError?.message ?? 'Native host disconnected'));
    });

    port.postMessage({ cmd: 'capture' } satisfies NativeCmd);
  });
}

/**
 * Fallback: open the select page in pick mode (no ?capture param). It hosts
 * the screen picker and the frame grab itself — see the header comment for
 * why neither may live in this worker.
 */
async function openScreenPicker(): Promise<void> {
  try {
    await browser.tabs.create({ url: browser.runtime.getURL('/select.html') });
  } catch (e) {
    console.error('[shotcache] failed to open picker page', e);
    flashGlobalBadge();
  }
}

/** Minimize the picker tab's window; returns its previous state for restore. */
async function hideWindow(winId: number | undefined): Promise<string | undefined> {
  if (winId == null) return undefined;
  const prev = (await browser.windows.get(winId).catch(() => undefined))?.state;
  await browser.windows.update(winId, { state: 'minimized' });
  return prev;
}

async function restoreWindow(winId: number | undefined, prevState?: string): Promise<void> {
  if (winId == null) return;
  const state =
    prevState === 'maximized' || prevState === 'fullscreen' ? prevState : 'normal';
  await browser.windows.update(winId, { state, focused: true }).catch(() => {});
}

/** Brief badge on the toolbar icon, not bound to a tab (screen capture has
 *  none): ✕ red for failures, ✓ green for a silent tray save. */
function flashGlobalBadge(text: '✕' | '✓' = '✕', color = '#e5534b'): void {
  void browser.action
    .setBadgeBackgroundColor({ color })
    .then(() => browser.action.setBadgeText({ text }))
    .then(() => {
      setTimeout(() => {
        void browser.action.setBadgeText({ text: '' }).catch(() => {});
        void browser.action.setBadgeBackgroundColor({ color: '#e5534b' }).catch(() => {});
      }, 1500);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Send-to-target orchestration
// ---------------------------------------------------------------------------

async function sendItems(target: TargetId, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) throw new Error('Nothing selected');

  const items: WireItem[] = [];
  for (const id of itemIds) {
    const item = await getTrayItem(id);
    if (!item) continue;
    if (item.kind === 'image' && item.blob) {
      items.push({ kind: 'image', title: item.title, imageBase64: await blobToBase64(item.blob) });
    } else {
      const raw = item.text ?? item.sourceUrl ?? '';
      // Code reaches the AI composer as a ready-made Markdown block; wrapping
      // here keeps the injector and every site adapter kind-agnostic.
      const text = item.kind === 'code' ? '```\n' + raw + '\n```' : raw;
      items.push({ kind: item.kind, title: item.title, text });
    }
  }
  if (items.length === 0) throw new Error('Selected items not found in tray');

  const tabId = await ensureTargetTab(target);
  await sendWithRetry(tabId, { type: 'INJECT_ITEMS', items });
}

/** Find an existing tab for the target or create one; return its tabId, focused. */
async function ensureTargetTab(target: TargetId): Promise<number> {
  const { urlPattern, newChatUrl } = TARGETS[target];
  const tabs = await browser.tabs.query({ url: urlPattern });
  if (tabs.length > 0 && tabs[0].id != null) {
    await browser.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) await browser.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0].id;
  }
  const tab = await browser.tabs.create({ url: newChatUrl });
  if (tab.id == null) throw new Error(`Failed to create ${TARGETS[target].label} tab`);
  return tab.id;
}

/**
 * The injector content script may not be ready yet on a freshly created tab,
 * so retry with backoff instead of listening for a "ready" handshake.
 */
async function sendWithRetry(tabId: number, msg: Msg, attempts = 12): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await browser.tabs.sendMessage(tabId, msg)) as MsgResponse;
      if (res?.ok) return;
      lastErr = new Error(res?.error ?? 'Injector returned not-ok');
    } catch (e) {
      lastErr = e; // receiving end does not exist yet -> retry
    }
    await new Promise((r) => setTimeout(r, 500 + i * 250));
  }
  throw lastErr ?? new Error('Injection timed out');
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
