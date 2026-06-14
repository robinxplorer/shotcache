// Region-select page for whole-desktop captures. Two modes by URL:
//  - no ?capture param (pick mode): this tab hosts the screen picker AND
//    consumes the stream itself. Both halves are page-bound platform rules:
//    the MV3 service worker may not call chooseDesktopMedia without a
//    targetTab, and the resulting streamId can only be passed to getUserMedia
//    by the page that requested it (an offscreen document gets AbortError —
//    desktopCapture lacks the cross-context support tabCapture gained in
//    Chrome 116). The background only minimizes/restores this window around
//    the grab so the shot shows the desktop, not the browser.
//  - ?capture=<id>: select mode. A live on-screen selector can't run outside
//    a web page, so the user picks the region on the already-captured frame:
//    drag a rubber band, or take the full frame. The chosen rect (bitmap
//    pixels, dpr=1) is written back onto the PendingCapture, then this tab
//    navigates to the editor — which crops with the exact same rect × dpr
//    logic as page captures.

import { getPending, putPending } from '@/shared/db';
import { initTheme } from '@/shared/theme';
import type { Msg, MsgResponse, PendingCapture } from '@/shared/types';
import { uid } from '@/shared/types';

const img = document.getElementById('shot') as HTMLImageElement;
const box = document.getElementById('box') as HTMLDivElement;
const sizeEl = document.getElementById('size') as HTMLDivElement;
const stage = document.getElementById('stage') as HTMLElement;

let pending: PendingCapture | null = null;
let dragging = false;
let startX = 0;
let startY = 0;

async function init(): Promise<void> {
  const id = new URLSearchParams(location.search).get('capture');
  if (!id) return startPicker(); // pick mode

  pending = (await getPending(id)) ?? null;
  if (!pending) return showStatus('截图已过期，请重新捕获');
  img.src = pending.dataUrl;
  bind();
}

/** Delay before the grab. Timers in a hidden tab are clamped to ~1s, which
 *  conveniently covers the window-minimize animation. */
const SETTLE_MS = 600;
const GRAB_TIMEOUT_MS = 10_000;

/** Pick mode: host the screen picker, then capture in this very page. */
function startPicker(): void {
  showStatus('请在弹出的选择器中选择要截取的屏幕…');
  browser.desktopCapture.chooseDesktopMedia(['screen'], (streamId) => {
    const err = browser.runtime.lastError;
    if (err) return showStatus(`无法发起屏幕选择：${err.message ?? '未知错误'}`);
    if (!streamId) return window.close(); // user cancelled the picker
    void captureScreen(streamId);
  });
}

/** Consume the stream, park one frame as a PendingCapture, then reload this
 *  tab in select mode on it. */
async function captureScreen(streamId: string): Promise<void> {
  showStatus('正在截取屏幕…');
  try {
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          // Without explicit max* the legacy constraint parser caps the track
          // at 640×480 — pass a generous ceiling to get native resolution.
          maxWidth: 16384,
          maxHeight: 16384,
        },
      },
    } as unknown as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    let frame: { dataUrl: string; width: number; height: number };
    const hide = (await browser.runtime
      .sendMessage({ type: 'HIDE_WINDOW' } satisfies Msg)
      .catch(() => undefined)) as MsgResponse | undefined;
    try {
      frame = await withTimeout(grabFrame(stream), GRAB_TIMEOUT_MS);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      if (hide?.ok) {
        void browser.runtime
          .sendMessage({ type: 'RESTORE_WINDOW', prevState: hide.windowState } satisfies Msg)
          .catch(() => {});
      }
    }

    const capture: PendingCapture = {
      id: uid(),
      createdAt: Date.now(),
      dataUrl: frame.dataUrl,
      // Full frame; the select mode this tab is about to enter narrows it.
      // dpr=1 because this rect is already in bitmap pixels.
      rect: { x: 0, y: 0, w: frame.width, h: frame.height },
      dpr: 1,
      sourceUrl: '',
      sourceTitle: '屏幕截图',
    };
    await putPending(capture);
    location.replace(browser.runtime.getURL(`/select.html?capture=${capture.id}`));
  } catch (e) {
    showStatus(`截图失败：${String(e)}`);
  }
}

interface ImageCaptureLike {
  grabFrame(): Promise<ImageBitmap>;
}

/** Grab one still frame. ImageCapture first — it pulls frames straight off
 *  the track, so it keeps working while this tab's window is minimized; a
 *  <video> element covers the occasional grabFrame() flake. */
async function grabFrame(
  stream: MediaStream,
): Promise<{ dataUrl: string; width: number; height: number }> {
  await new Promise((r) => setTimeout(r, SETTLE_MS)); // minimize settle
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('No video track');

  const IC = (
    globalThis as unknown as {
      ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike;
    }
  ).ImageCapture;

  let bitmap: ImageBitmap;
  try {
    if (!IC) throw new Error('ImageCapture unavailable');
    bitmap = await new IC(track).grabFrame();
  } catch {
    bitmap = await frameViaVideo(stream);
  }

  if (bitmap.width === 0 || bitmap.height === 0) throw new Error('Empty video frame');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

async function frameViaVideo(stream: MediaStream): Promise<ImageBitmap> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  await new Promise((r) => setTimeout(r, 300));
  return createImageBitmap(video);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`截屏超时（${ms / 1000} 秒）`)), ms),
    ),
  ]);
}

/** Status/error display shared by pick mode and the expired-capture path. */
function showStatus(text: string): void {
  const el = document.getElementById('fail')!;
  el.textContent = text;
  el.hidden = false;
  document.getElementById('hint')!.hidden = true;
  stage.style.display = 'none';
}

function bind(): void {
  stage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const p = clampToImg(e.clientX, e.clientY);
    dragging = true;
    startX = p.x;
    startY = p.y;
    box.hidden = false;
    sizeEl.hidden = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = viewRect(e);
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${r.w}px`;
    box.style.height = `${r.h}px`;
    const px = toImagePixels(r);
    sizeEl.textContent = `${px.w} × ${px.h}`;
    sizeEl.style.left = `${r.x}px`;
    sizeEl.style.top = `${Math.max(0, r.y - 24)}px`;
  });

  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    box.hidden = true;
    sizeEl.hidden = true;
    const px = toImagePixels(viewRect(e));
    if (px.w < 4 || px.h < 4) return; // accidental click — keep selecting
    void confirmRect(px);
  });

  document.getElementById('use-full')!.addEventListener('click', () => {
    // The pending rect already covers the full frame (set by pick mode).
    if (pending) goEditor(pending.id);
  });

  window.addEventListener('keydown', (e) => {
    // Abandoned pending records are swept by the background GC (PENDING_TTL_MS).
    if (e.key === 'Escape') window.close();
  });
}

/** Current drag rectangle in viewport coords, clamped to the displayed image. */
function viewRect(e: MouseEvent): { x: number; y: number; w: number; h: number } {
  const p = clampToImg(e.clientX, e.clientY);
  return {
    x: Math.min(startX, p.x),
    y: Math.min(startY, p.y),
    w: Math.abs(p.x - startX),
    h: Math.abs(p.y - startY),
  };
}

function clampToImg(clientX: number, clientY: number): { x: number; y: number } {
  const r = img.getBoundingClientRect();
  return {
    x: Math.min(Math.max(clientX, r.left), r.right),
    y: Math.min(Math.max(clientY, r.top), r.bottom),
  };
}

/** Map a viewport-space rect over the CSS-scaled <img> back to bitmap pixels. */
function toImagePixels(r: { x: number; y: number; w: number; h: number }) {
  const b = img.getBoundingClientRect();
  const scaleX = img.naturalWidth / b.width;
  const scaleY = img.naturalHeight / b.height;
  return {
    x: Math.round((r.x - b.left) * scaleX),
    y: Math.round((r.y - b.top) * scaleY),
    w: Math.round(r.w * scaleX),
    h: Math.round(r.h * scaleY),
  };
}

async function confirmRect(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  if (!pending) return;
  pending.rect = rect;
  await putPending(pending);
  goEditor(pending.id);
}

function goEditor(id: string): void {
  location.replace(browser.runtime.getURL(`/editor.html?capture=${id}`));
}

initTheme();
void init();
