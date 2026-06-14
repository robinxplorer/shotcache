// Global capture-hotkey model + helpers, shared by the popup (key recorder +
// settings UI) and the background (push to the native host over the port).
//
// This is ONLY the native host's RegisterHotKey (default Ctrl+Alt+A, works in
// any app). The in-Chrome command (Alt+Shift+F) is NOT modelled here: MV3
// forbids setting a command's shortcut programmatically — it can only be
// changed at chrome://extensions/shortcuts.

export interface Hotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  /** Main key token: 'A'..'Z', '0'..'9', or 'F1'..'F12'. */
  key: string;
}

/** chrome.storage.local key holding the user's chosen hotkey — the source of
 *  truth. The host keeps its own file cache only so the hotkey is live the
 *  instant it starts; the background re-pushes this on every connect. */
export const HOTKEY_KEY = 'shotcache.hotkey';

export const DEFAULT_HOTKEY: Hotkey = { ctrl: true, alt: true, shift: false, win: false, key: 'A' };

// Win32 RegisterHotKey modifier flags.
const MOD_ALT = 0x1;
const MOD_CONTROL = 0x2;
const MOD_SHIFT = 0x4;
const MOD_WIN = 0x8;

/** "Ctrl+Alt+A" — the order Windows shows and users expect. */
export function formatHotkey(h: Hotkey): string {
  const parts: string[] = [];
  if (h.ctrl) parts.push('Ctrl');
  if (h.alt) parts.push('Alt');
  if (h.shift) parts.push('Shift');
  if (h.win) parts.push('Win');
  parts.push(h.key);
  return parts.join('+');
}

/** Usable only with ≥1 non-Shift modifier and a known main key — otherwise
 *  RegisterHotKey would hijack a bare (or Shift+) key across the whole OS. */
export function isValidHotkey(h: Hotkey): boolean {
  return toWin32(h) != null;
}

/** Win32 fsModifiers bitmask + virtual-key code, or null if not registrable. */
export function toWin32(h: Hotkey): { mods: number; vk: number } | null {
  const vk = keyToVk(h.key);
  if (vk <= 0 || !(h.ctrl || h.alt || h.win)) return null;
  let mods = 0;
  if (h.alt) mods |= MOD_ALT;
  if (h.ctrl) mods |= MOD_CONTROL;
  if (h.shift) mods |= MOD_SHIFT;
  if (h.win) mods |= MOD_WIN;
  return { mods, vk };
}

/** Build a Hotkey from a keydown, or null if the pressed key isn't a usable
 *  main key yet (a lone modifier, or an unsupported key). */
export function hotkeyFromEvent(e: KeyboardEvent): Hotkey | null {
  const key = codeToKey(e.code);
  if (!key) return null;
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, win: e.metaKey, key };
}

export function sameHotkey(a: Hotkey, b: Hotkey): boolean {
  return (
    a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.win === b.win && a.key === b.key
  );
}

function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return null;
}

function keyToVk(key: string): number {
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0); // VK_A..Z / VK_0..9 == ASCII
  const f = /^F([1-9]|1[0-2])$/.exec(key);
  if (f) return 0x70 + (parseInt(f[1], 10) - 1); // VK_F1 = 0x70
  return 0;
}
