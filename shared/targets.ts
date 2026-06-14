// Send targets — one entry per AI chat site we can inject into.
// Adding a target = add an entry here + a thin <site>.content.ts that calls
// setupInjector() with site-specific composer selectors + the host permission
// in wxt.config.ts. Everything else (sidepanel select, background routing)
// picks it up from this table.

export const TARGETS = {
  claude: {
    label: 'Claude',
    urlPattern: 'https://claude.ai/*',
    newChatUrl: 'https://claude.ai/new',
  },
  chatgpt: {
    label: 'ChatGPT',
    urlPattern: 'https://chatgpt.com/*',
    newChatUrl: 'https://chatgpt.com/',
  },
  gemini: {
    label: 'Gemini',
    urlPattern: 'https://gemini.google.com/*',
    newChatUrl: 'https://gemini.google.com/app',
  },
} as const;

export type TargetId = keyof typeof TARGETS;

export const isTargetId = (v: string): v is TargetId => v in TARGETS;
