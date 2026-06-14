// Protocol v2 between the extension and the resident native host
// (native-host/host.cs). Carried over a persistent runtime.connectNative
// port; the host's 20s pings reset the MV3 service worker's idle timer so
// the port — and with it the global hotkey — stays alive while Chrome runs.

export const NATIVE_HOST_NAME = 'com.shotcache.capture';

/** storage.local key holding the host's hotkey-registration failure, if any.
 *  Set on `hotkey-failed`, cleared on every successful hello. The popup shows
 *  it as a warning banner. */
export const HOTKEY_ERROR_KEY = 'shotcache.hotkeyError';

/** Annotation emoji set — must stay in sync with overlay.cs EMOJIS and the
 *  browser editor's palette. The extension renders these on a canvas (GDI+
 *  cannot rasterize color fonts) and ships them to the host as PNGs. */
export const EMOJIS = [
  '😂', '😍', '😮', '😡', '😢', '👍', '👎', '🙏',
  '❤️', '💔', '🎉', '🔥', '✅', '❌', '❓', '⚠️',
] as const;

/** extension -> host */
export type NativeCmd =
  | { cmd: 'hello' }
  | { cmd: 'capture'; headless?: boolean }
  | { cmd: 'emoji-sheet'; size: number; entries: { ch: string; data: string }[] }
  /** Re-register the global capture hotkey. mods = Win32 fsModifiers bitmask,
   *  vk = virtual-key code, label = human string for the host's error text. */
  | { cmd: 'set-hotkey'; mods: number; vk: number; label: string };

/** host -> extension */
export interface NativeHello {
  type: 'hello';
  version: number;
}
export interface NativePing {
  type: 'ping';
}
export interface NativeShotMeta {
  type: 'shot-meta';
  width: number;
  height: number;
  chunks: number;
  /** true when this shot was spooled to disk because the pipe died mid-capture */
  spool?: boolean;
  /** true = open in the browser editor (longshot), not straight to the tray */
  edit?: boolean;
}
export interface NativeShotChunk {
  type: 'shot-chunk';
  seq: number;
  /** base64 PNG fragment (~512KB; Chrome caps host messages at 1 MB) */
  data: string;
}
export interface NativeShotDone {
  type: 'shot-done';
}
export interface NativeCancelled {
  type: 'cancelled';
}
export interface NativeError {
  type: 'error';
  message?: string;
}
export interface NativeHotkeyFailed {
  type: 'hotkey-failed';
  message?: string;
}
/** Reply to a `set-hotkey` command: ok=true registered, else message says why. */
export interface NativeHotkeySet {
  type: 'hotkey-set';
  ok: boolean;
  message?: string;
}

export type NativeInMsg =
  | NativeHello
  | NativePing
  | NativeShotMeta
  | NativeShotChunk
  | NativeShotDone
  | NativeCancelled
  | NativeError
  | NativeHotkeyFailed
  | NativeHotkeySet;
