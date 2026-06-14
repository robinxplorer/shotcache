// Shared composer-injection logic, used by every <site>.content.ts.
//
// Injection mechanism: build a DataTransfer with File/text entries and dispatch
// a synthetic ClipboardEvent('paste') on the site's composer. This is the same
// path a real Ctrl+V takes, so the site's own paste handling (image upload,
// rich text) does the heavy lifting — far more robust than poking the DOM.
//
// ⚠️ The selector chains passed in by each adapter are FRAGILE BY NATURE: they
// depend on each site's DOM and need re-verification when a site redesigns.
// In a real product, load the selector config from a remote JSON you control
// (remote *config* is allowed under MV3 policy; remote *code* is not).

import { browser } from 'wxt/browser';
import type { InjectItemsMsg, Msg, MsgResponse, WireItem } from './types';

export interface InjectorAdapter {
  /** Ordered fallback chain — first matching contenteditable wins. */
  composerSelectors: string[];
  /** How long to keep polling for the composer on a freshly loaded page. */
  composerTimeoutMs: number;
}

/** Register the INJECT_ITEMS listener. Call once from the content script. */
export function setupInjector(adapter: InjectorAdapter): void {
  browser.runtime.onMessage.addListener(
    (msg: Msg, _sender, sendResponse: (r: MsgResponse) => void) => {
      if (msg.type !== 'INJECT_ITEMS') return;
      injectItems(adapter, msg)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error('[shotcache] inject failed', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true; // async
    },
  );
}

async function injectItems(adapter: InjectorAdapter, msg: InjectItemsMsg): Promise<void> {
  const composer = await waitForComposer(adapter);
  composer.focus();

  // Text items go in one combined paste; each image is a separate paste event
  // because upload handlers treat files individually anyway and mixing
  // files+text in one DataTransfer makes some editors drop the text part.
  const textParts = msg.items
    .filter((i) => i.kind !== 'image')
    .map((i) => i.text ?? '')
    .filter(Boolean);

  if (textParts.length > 0) {
    dispatchPaste(composer, { text: textParts.join('\n\n') });
  }

  for (const item of msg.items) {
    if (item.kind !== 'image' || !item.imageBase64) continue;
    const file = new File([base64ToBytes(item.imageBase64)], fileNameFor(item), {
      type: 'image/png',
    });
    dispatchPaste(composer, { file });
    // Give the site's upload pipeline a beat between files.
    await sleep(300);
  }
}

function fileNameFor(item: WireItem): string {
  const safe = item.title.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'screenshot';
  return `${safe}.png`;
}

function dispatchPaste(target: HTMLElement, payload: { text?: string; file?: File }): void {
  const dt = new DataTransfer();
  if (payload.text) dt.setData('text/plain', payload.text);
  if (payload.file) dt.items.add(payload.file);

  const ok = target.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
  );

  // Fallback for text if the site swallowed the event without inserting.
  if (payload.text && ok && !target.textContent?.includes(payload.text.slice(0, 20))) {
    try {
      document.execCommand('insertText', false, payload.text);
    } catch {
      /* best effort */
    }
  }
}

function waitForComposer(adapter: InjectorAdapter): Promise<HTMLElement> {
  const find = (): HTMLElement | null => {
    for (const sel of adapter.composerSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && el.isContentEditable) return el;
    }
    return null;
  };

  return new Promise((resolve, reject) => {
    const existing = find();
    if (existing) return resolve(existing);

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Composer not found — the site DOM may have changed (update the adapter)'));
    }, adapter.composerTimeoutMs);

    const observer = new MutationObserver(() => {
      const el = find();
      if (el) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
