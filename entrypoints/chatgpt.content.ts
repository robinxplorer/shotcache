// ChatGPT injector — declared content script, runs only on https://chatgpt.com/*.
// Same shape as claude.content.ts: shared logic + a site-specific selector chain.

import { setupInjector } from '@/shared/injector';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  main() {
    setupInjector({
      // #prompt-textarea has been the composer id across several redesigns
      // (it is a contenteditable ProseMirror div these days, not a textarea).
      composerSelectors: [
        '#prompt-textarea',
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"]',
      ],
      composerTimeoutMs: 15_000,
    });
  },
});
