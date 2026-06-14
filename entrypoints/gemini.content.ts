// Gemini injector — declared content script, runs only on https://gemini.google.com/*.
// Same shape as claude.content.ts: shared logic + a site-specific selector chain.

import { setupInjector } from '@/shared/injector';

export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  main() {
    setupInjector({
      // Gemini's composer is a Quill editor inside a <rich-textarea>.
      composerSelectors: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"]',
      ],
      composerTimeoutMs: 15_000,
    });
  },
});
