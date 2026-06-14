// Browser-extension API mock for the demo harness. Injected into editor.html
// and sidepanel.html by demo/server.mjs so the real built bundles run in a
// plain browser tab. Cross-frame runtime messages ride a BroadcastChannel;
// things only the background/shell can do are postMessage'd to the shell.
(() => {
  const bc = new BroadcastChannel('shotcache-demo');
  const listeners = [];
  bc.onmessage = (e) => {
    if (e.data?.kind !== 'runtime') return;
    for (const fn of listeners) fn(e.data.msg, {}, () => {});
  };

  const toShell = (kind, data = {}) => {
    if (window.parent !== window) window.parent.postMessage({ kind, ...data }, '*');
  };

  const FAKE_TAB = {
    id: 1,
    title: 'MV3 扩展的权限模型 · Example Dev Blog',
    url: 'https://example.com/articles/mv3-permissions',
  };

  globalThis.browser = {
    runtime: {
      id: 'shotcache-demo',
      getURL: (p) => p,
      sendMessage: (msg) => {
        bc.postMessage({ kind: 'runtime', msg });
        toShell('runtime', { msg });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: {
      query: async () => [FAKE_TAB],
      create: async ({ url }) => {
        toShell('open-url', { url });
        return { id: 2 };
      },
      update: async () => ({}),
      sendMessage: async () => ({ ok: true }),
    },
    windows: { getCurrent: async () => ({ id: 1 }), update: async () => ({}) },
    sidePanel: { open: async () => toShell('open-sidepanel') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  };
  globalThis.chrome = globalThis.browser;

  // prompt() would block automation — return a canned value, overridable per test.
  window.prompt = () => window.__promptValue ?? '演示输入';
})();
