// Claude injector — declared content script, runs only on https://claude.ai/*.
// All real logic lives in shared/injector.ts; this file is just the adapter:
// the ONLY thing that needs maintenance when claude.ai ships a redesign is
// the selector chain below.

import { setupInjector } from '@/shared/injector';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  main() {
    setupInjector({
      // Ordered fallback chain — first match wins. NEEDS RE-VERIFICATION over time.
      composerSelectors: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][aria-label]',
        'div[contenteditable="true"]',
      ],
      composerTimeoutMs: 15_000,
    });
  },
});
