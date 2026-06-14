// Annotation editor.
// Pipeline: load PendingCapture from IDB -> crop region (rect × dpr) onto a
// base canvas -> annotation ops live in an array and get replayed on every
// redraw (cheap undo) -> on save, the composited canvas is exported to PNG,
// stored in the tray with a thumbnail.
//
// The pending record is deleted only AFTER a successful save (so a reload of
// this tab re-opens the capture); abandoned records are swept by the
// background GC after PENDING_TTL_MS.

import { deletePending, getPending, putTrayItem } from '@/shared/db';
import { EMOJIS } from '@/shared/native';
import { currentTheme, initTheme, toggleTheme } from '@/shared/theme';
import type { TrayItem } from '@/shared/types';
import { uid } from '@/shared/types';

type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'mosaic' | 'emoji';

interface DrawOp {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text?: string;
  /** Style, stamped at creation — changing the bar never repaints old ops. */
  color: string;
  width: number;
  fontPx: number;
  cell: number;
  emojiPx: number;
}

// Style tiers — one knob drives every tool (kept in sync with overlay.cs).
const PALETTE = ['#ff4d4f', '#ff9f1a', '#ffd21e', '#2ea043', '#1180ff', '#8957e5', '#1f1f1f', '#ffffff'];
const STROKE_TIERS = [2, 4, 7];
const FONT_TIERS = [16, 22, 30];
const CELL_TIERS = [8, 12, 18];
const EMOJI_TIERS = [28, 40, 56];

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;

let base: HTMLCanvasElement; // cropped screenshot, never mutated
let basePixels: ImageData | null = null; // lazy cache for mosaic sampling
let ops: DrawOp[] = [];
let tool: Tool = 'rect';
let styleTier = 1;
let curColor = PALETTE[0];
let curEmoji: string = EMOJIS[5]; // 👍
let dragging = false;
let cur: DrawOp | null = null;
// Selection / re-edit state (select tool).
let selectedIndex = -1;
let moving = false;
let moveStartX = 0;
let moveStartY = 0;
let moveOrig: DrawOp | null = null;
let captureId = '';
let sourceTitle = 'screenshot';
let sourceUrl = '';

async function init(): Promise<void> {
  const id = new URLSearchParams(location.search).get('capture');
  if (!id) return fail('缺少 capture 参数');
  captureId = id;

  const pending = await getPending(id);
  if (!pending) return fail('截图已过期，请重新捕获');

  sourceTitle = pending.sourceTitle || 'screenshot';
  sourceUrl = pending.sourceUrl;

  const img = await loadImage(pending.dataUrl);

  // Crop: rect is in CSS pixels, the bitmap is in device pixels. Clamp to the
  // bitmap so a selection that brushes the viewport edge can't go negative.
  const { rect, dpr } = pending;
  const sx = clamp(Math.round(rect.x * dpr), 0, img.width - 1);
  const sy = clamp(Math.round(rect.y * dpr), 0, img.height - 1);
  const sw = Math.max(1, Math.min(Math.round(rect.w * dpr), img.width - sx));
  const sh = Math.max(1, Math.min(Math.round(rect.h * dpr), img.height - sy));

  base = document.createElement('canvas');
  base.width = sw;
  base.height = sh;
  base.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  canvas.width = sw;
  canvas.height = sh;
  redraw();
  status(`${sw} × ${sh} px · 来源：${sourceTitle}`);

  bindUi();
}

// --- rendering ---

function redraw(preview?: DrawOp): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  for (const op of ops) paint(op);
  if (preview) paint(preview);
  if (!preview && selectedIndex >= 0 && selectedIndex < ops.length) {
    paintSelection(ops[selectedIndex]);
  }
}

/** Dashed accent box around the selected op. It IS painted onto the live
 *  canvas, so every export path calls clearSelection() first to strip it. */
function paintSelection(op: DrawOp): void {
  const b = opBounds(op);
  ctx.save();
  ctx.strokeStyle = '#6f5ae8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8);
  ctx.restore();
}

/** Axis-aligned bounds of an op in bitmap coords. */
function opBounds(op: DrawOp): { x: number; y: number; w: number; h: number } {
  if (op.tool === 'text') {
    ctx.save();
    ctx.font = `${op.fontPx}px system-ui, sans-serif`;
    const w = op.text ? ctx.measureText(op.text).width : 0;
    ctx.restore();
    return { x: op.x1, y: op.y1, w, h: op.fontPx };
  }
  if (op.tool === 'emoji') {
    const s = op.emojiPx;
    return { x: op.x1 - s / 2, y: op.y1 - s / 2, w: s, h: s };
  }
  const x = Math.min(op.x1, op.x2);
  const y = Math.min(op.y1, op.y2);
  return { x, y, w: Math.abs(op.x2 - op.x1), h: Math.abs(op.y2 - op.y1) };
}

/** Topmost op under (x, y), or -1. Iterates last-drawn first. */
function hitTest(x: number, y: number): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.tool === 'arrow') {
      if (distToSeg(x, y, op.x1, op.y1, op.x2, op.y2) <= Math.max(op.width, 6)) return i;
      continue;
    }
    const b = opBounds(op);
    const pad = Math.max(op.width, 6);
    if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return i;
  }
  return -1;
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function paint(op: DrawOp): void {
  const x = Math.min(op.x1, op.x2);
  const y = Math.min(op.y1, op.y2);
  const w = Math.abs(op.x2 - op.x1);
  const h = Math.abs(op.y2 - op.y1);

  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.width;

  switch (op.tool) {
    case 'rect':
      ctx.strokeRect(x, y, w, h);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'arrow':
      paintArrow(op.x1, op.y1, op.x2, op.y2);
      break;
    case 'text':
      if (op.text) {
        ctx.font = `${op.fontPx}px system-ui, sans-serif`;
        ctx.textBaseline = 'top';
        ctx.fillText(op.text, op.x1, op.y1);
      }
      break;
    case 'mosaic':
      paintMosaic(x, y, w, h, op.cell);
      break;
    case 'emoji':
      if (op.text) {
        // Canvas renders color emoji natively; centered on the click point.
        ctx.font = `${op.emojiPx}px "Segoe UI Emoji", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(op.text, op.x1, op.y1);
      }
      break;
  }
  ctx.restore();
}

function paintArrow(x1: number, y1: number, x2: number, y2: number): void {
  const head = Math.max(10, ctx.lineWidth * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

/**
 * Pixelate by sampling the BASE image (so stacked mosaics don't re-blur
 * annotations). Samples come from one cached getImageData of the whole base —
 * a getImageData per cell makes drag-preview redraws crawl on large captures.
 */
function paintMosaic(x: number, y: number, w: number, h: number, cell: number): void {
  if (!basePixels) {
    basePixels = base.getContext('2d')!.getImageData(0, 0, base.width, base.height);
  }
  const px0 = Math.max(0, Math.floor(x));
  const py0 = Math.max(0, Math.floor(y));
  for (let py = py0; py < y + h && py < base.height; py += cell) {
    for (let px = px0; px < x + w && px < base.width; px += cell) {
      const cw = Math.min(cell, x + w - px);
      const ch = Math.min(cell, y + h - py);
      if (cw <= 0 || ch <= 0) continue;
      const o = (py * base.width + px) * 4;
      const d = basePixels.data;
      ctx.fillStyle = `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`;
      ctx.fillRect(px, py, cw, ch);
    }
  }
}

// --- interaction ---

function bindUi(): void {
  initStyleBar();

  const themeBtn = document.getElementById('theme') as HTMLButtonElement;
  const paintTheme = () => {
    const dark = currentTheme() === 'dark';
    themeBtn.textContent = dark ? '🌙' : '☀️';
    themeBtn.title = dark ? '当前深色，点击切换浅色' : '当前浅色，点击切换深色';
  };
  paintTheme();
  themeBtn.addEventListener('click', () => {
    toggleTheme();
    paintTheme();
  });

  const pos = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    // Canvas may be CSS-scaled (max-width:100%); map back to bitmap coords.
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };

  const newOp = (x: number, y: number): DrawOp => ({
    tool,
    x1: x,
    y1: y,
    x2: x,
    y2: y,
    color: curColor,
    width: STROKE_TIERS[styleTier],
    fontPx: FONT_TIERS[styleTier],
    cell: CELL_TIERS[styleTier],
    emojiPx: EMOJI_TIERS[styleTier],
  });

  canvas.addEventListener('mousedown', (e) => {
    const p = pos(e);
    if (tool === 'select') {
      selectedIndex = hitTest(p.x, p.y);
      if (selectedIndex >= 0) {
        moving = true;
        moveStartX = p.x;
        moveStartY = p.y;
        moveOrig = { ...ops[selectedIndex] };
        status('已选中：拖动移动 · Del 删除 · 改色/粗细改样式 · 双击文字改字');
      }
      redraw();
      return;
    }
    if (tool === 'text') {
      const text = prompt('输入标注文字：');
      if (text) {
        ops.push({ ...newOp(p.x, p.y), text });
        redraw();
      }
      return;
    }
    if (tool === 'emoji') {
      ops.push({ ...newOp(p.x, p.y), text: curEmoji });
      redraw();
      return;
    }
    dragging = true;
    cur = newOp(p.x, p.y);
  });

  canvas.addEventListener('mousemove', (e) => {
    const p = pos(e);
    if (moving && moveOrig && selectedIndex >= 0) {
      const dx = p.x - moveStartX;
      const dy = p.y - moveStartY;
      const o = ops[selectedIndex];
      o.x1 = moveOrig.x1 + dx;
      o.y1 = moveOrig.y1 + dy;
      o.x2 = moveOrig.x2 + dx;
      o.y2 = moveOrig.y2 + dy;
      redraw();
      return;
    }
    if (!dragging || !cur) return;
    cur.x2 = p.x;
    cur.y2 = p.y;
    redraw(cur);
  });

  window.addEventListener('mouseup', () => {
    if (moving) {
      moving = false;
      moveOrig = null;
      return;
    }
    if (!dragging || !cur) return;
    dragging = false;
    if (Math.abs(cur.x2 - cur.x1) > 3 || Math.abs(cur.y2 - cur.y1) > 3) ops.push(cur);
    cur = null;
    redraw();
  });

  // Double-click a text op (select tool) to re-edit it (empty input deletes it).
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return;
    const p = pos(e);
    const hit = hitTest(p.x, p.y);
    if (hit < 0 || ops[hit].tool !== 'text') return;
    const next = prompt('编辑文字：', ops[hit].text ?? '');
    if (next === null) return;
    if (next.trim() === '') {
      ops.splice(hit, 1);
      selectedIndex = -1;
    } else {
      ops[hit].text = next;
      selectedIndex = hit;
    }
    redraw();
  });

  document.getElementById('tools')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tool]');
    if (btn) selectTool(btn.dataset.tool as Tool);
  });

  document.getElementById('undo')!.addEventListener('click', undo);

  const TOOL_KEYS: Record<string, Tool> = {
    v: 'select',
    r: 'rect',
    e: 'ellipse',
    a: 'arrow',
    t: 'text',
    m: 'mosaic',
    j: 'emoji',
  };
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex >= 0) {
      e.preventDefault();
      ops.splice(selectedIndex, 1);
      selectedIndex = -1;
      redraw();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = TOOL_KEYS[e.key.toLowerCase()];
    if (t) selectTool(t);
  });

  document.getElementById('copy')!.addEventListener('click', () => {
    clearSelection();
    void exportBlob().then(async (blob) => {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status('已复制到剪贴板');
    });
  });

  document.getElementById('download')!.addEventListener('click', () => {
    clearSelection();
    void exportBlob().then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${safeFileName(sourceTitle)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    });
  });

  document.getElementById('save')!.addEventListener('click', () => {
    void saveToTray();
  });
}

function selectTool(t: Tool): void {
  if (t !== 'select') clearSelection(); // drawing tools drop any selection
  tool = t;
  document
    .querySelectorAll<HTMLButtonElement>('button[data-tool]')
    .forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('emojis')!.hidden = t !== 'emoji';
  canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
}

/** Drop the current selection and repaint without its chrome box. */
function clearSelection(): void {
  if (selectedIndex < 0) return;
  selectedIndex = -1;
  redraw();
}

function initStyleBar(): void {
  const widths = document.getElementById('widths')!;
  widths.querySelectorAll<HTMLButtonElement>('button[data-tier]').forEach((b) => {
    b.addEventListener('click', () => {
      styleTier = Number(b.dataset.tier);
      widths.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      // Re-style the selected op too (its stamped width/font/cell/emoji size).
      if (selectedIndex >= 0) {
        const o = ops[selectedIndex];
        o.width = STROKE_TIERS[styleTier];
        o.fontPx = FONT_TIERS[styleTier];
        o.cell = CELL_TIERS[styleTier];
        o.emojiPx = EMOJI_TIERS[styleTier];
        redraw();
      }
    });
  });

  const swatches = document.getElementById('swatches')!;
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.className = `swatch${c === curColor ? ' active' : ''}`;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      curColor = c;
      swatches.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === b));
      if (selectedIndex >= 0) {
        ops[selectedIndex].color = c;
        redraw();
      }
    });
    swatches.append(b);
  }

  const emojis = document.getElementById('emojis')!;
  for (const ch of EMOJIS) {
    const b = document.createElement('button');
    b.textContent = ch;
    b.classList.toggle('active', ch === curEmoji);
    b.addEventListener('click', () => {
      curEmoji = ch;
      emojis.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      if (selectedIndex >= 0 && ops[selectedIndex].tool === 'emoji') {
        ops[selectedIndex].text = ch;
        redraw();
      }
    });
    emojis.append(b);
  }
}

function undo(): void {
  ops.pop();
  selectedIndex = -1;
  redraw();
}

// --- export / save ---

function exportBlob(): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      'image/png',
    );
  });
}

async function saveToTray(): Promise<void> {
  try {
    clearSelection();
    const blob = await exportBlob();
    const item: TrayItem = {
      id: uid(),
      kind: 'image',
      createdAt: Date.now(),
      title: sourceTitle,
      sourceUrl,
      blob,
      thumb: makeThumb(),
    };
    await putTrayItem(item);
    await deletePending(captureId).catch(() => {});
    void browser.runtime.sendMessage({ type: 'TRAY_UPDATED' }).catch(() => {});
    status('已存入托盘 — 点击工具栏图标查看与发送');
  } catch (e) {
    status(`保存失败：${String(e)}`);
  }
}

function makeThumb(maxW = 160): string {
  const scale = Math.min(1, maxW / canvas.width);
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * scale);
  t.height = Math.round(canvas.height * scale);
  t.getContext('2d')!.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

// --- helpers ---

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode screenshot'));
    img.src = src;
  });
}

function safeFileName(s: string): string {
  return s.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'screenshot';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const status = (s: string) => (statusEl.textContent = s);
const fail = (s: string) => {
  status(s);
  throw new Error(s);
};

// Apply the saved theme before init paints to avoid a flash of the wrong mode.
initTheme();
// Kept last: init's synchronous prefix (the missing-param fail() path) touches
// the const helpers above — calling earlier hits the TDZ.
void init();
