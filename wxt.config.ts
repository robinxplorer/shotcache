import { defineConfig } from 'wxt';

// Permission strategy (keep this minimal — it directly affects Web Store review):
// - host_permissions: one entry per send target, required for the declared
//   injector content scripts (claude/chatgpt/gemini.content.ts).
// - unlimitedStorage: tray images live in IndexedDB; default quota is too small.
// - alarms: periodic expiry sweep of tray + pending stores (setTimeout dies
//   with the MV3 service worker).
// - nativeMessaging: preferred whole-desktop screenshot path — the companion
//   host (native-host/, installed by the user) grabs the screen silently,
//   WeChat-style, no picker. The overlay owns framing/annotation/longshot.
// - desktopCapture: extension-only FALLBACK when the host is not installed.
//   The screen picker is mandatory there. select.html hosts the picker AND
//   consumes the stream itself — a chooseDesktopMedia streamId is bound to
//   the page that requested it (worker/offscreen consumption fails).
// (activeTab + scripting dropped: capture is now whole-screen only — the
//  in-page region selector and DOM longshot, the only executeScript callers,
//  were removed; everything converges on the native overlay toolbar.)
export default defineConfig({
  manifest: {
    name: 'Shotcache（截存）',
    description: '截图、标注、暂存、一键发给 Claude / ChatGPT / Gemini。Capture, annotate, stash, send to AI chat in one click.',
    permissions: ['storage', 'unlimitedStorage', 'tabs', 'alarms', 'desktopCapture', 'nativeMessaging'],
    host_permissions: [
      'https://claude.ai/*',
      'https://chatgpt.com/*',
      'https://gemini.google.com/*',
    ],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '截存：截图与托盘',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    commands: {
      'capture-screen': {
        suggested_key: { default: 'Alt+Shift+F' },
        description: 'Capture the entire screen (desktop)',
      },
    },
  },
});
