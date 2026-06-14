// Shared types: message protocol + tray data model.
// Every cross-context message (content <-> background <-> popup <-> editor)
// goes through this discriminated union so the protocol stays greppable.

import type { Hotkey } from './hotkey';
import type { TargetId } from './targets';

export type ItemKind = 'image' | 'text' | 'link' | 'code';

export interface TrayItem {
  id: string;
  kind: ItemKind;
  createdAt: number;
  /** Page title / user note title */
  title: string;
  /** Source page URL, if any */
  sourceUrl?: string;
  /** Payload for kind=text|link */
  text?: string;
  /** Payload for kind=image (PNG). Stored in IndexedDB, NOT in chrome.storage. */
  blob?: Blob;
  /** Small data-URL thumbnail for fast list rendering */
  thumb?: string;
}

/** A captured-but-not-yet-edited screenshot, parked in IDB between capture and editor. */
export interface PendingCapture {
  id: string;
  createdAt: number;
  /** Full visible-viewport screenshot as data URL (PNG) */
  dataUrl: string;
  /** Selected region in CSS pixels, relative to viewport */
  rect: { x: number; y: number; w: number; h: number };
  /** window.devicePixelRatio at capture time — crop MUST multiply by this */
  dpr: number;
  sourceUrl: string;
  sourceTitle: string;
}

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

/** popup -> background: send selected tray items to an AI chat target */
export interface SendItemsMsg {
  type: 'SEND_ITEMS';
  target: TargetId;
  itemIds: string[];
}

/** background -> content(site injector): inject these items into the composer */
export interface InjectItemsMsg {
  type: 'INJECT_ITEMS';
  items: WireItem[];
}

/** popup/command -> background: start the whole-desktop capture flow */
export interface RequestScreenCaptureMsg {
  type: 'REQUEST_SCREEN_CAPTURE';
}

/** popup -> background: persist + apply the global capture hotkey. Saved to
 *  storage always; pushed to the host if the port is up (else applied on the
 *  next connect). */
export interface SetHotkeyMsg {
  type: 'SET_HOTKEY';
  hotkey: Hotkey;
}

/** select(pick mode) -> background: minimize my window before the frame grab.
 *  Response carries the window's previous state for the later restore. */
export interface HideWindowMsg {
  type: 'HIDE_WINDOW';
}

/** select(pick mode) -> background: grab finished (or failed) — restore my
 *  window to prevState (echoed back from the HIDE_WINDOW response). */
export interface RestoreWindowMsg {
  type: 'RESTORE_WINDOW';
  prevState?: string;
}

/** any -> popup: tray contents changed, re-render */
export interface TrayUpdatedMsg {
  type: 'TRAY_UPDATED';
}

/** Serializable form of a TrayItem for tabs.sendMessage (Blob can't cross). */
export interface WireItem {
  kind: ItemKind;
  title: string;
  text?: string;
  /** base64 (no data: prefix) PNG payload for kind=image */
  imageBase64?: string;
}

export type Msg =
  | SendItemsMsg
  | InjectItemsMsg
  | RequestScreenCaptureMsg
  | SetHotkeyMsg
  | HideWindowMsg
  | RestoreWindowMsg
  | TrayUpdatedMsg;

export interface MsgResponse {
  ok: boolean;
  error?: string;
  /** HIDE_WINDOW success: the window state to restore afterwards */
  windowState?: string;
  /** SET_HOTKEY: saved, but the host wasn't connected — applies on next start. */
  pending?: boolean;
}

export const uid = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
