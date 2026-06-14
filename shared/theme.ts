// Light/dark theme for the extension's own pages (popup, editor, select).
// All extension pages share the chrome-extension origin, so a single
// synchronous localStorage key keeps them in sync with no first-paint flash
// (chrome.storage is async and would flicker). Default follows the OS; an
// explicit user choice is pinned and wins until cleared.
//
// The palettes themselves live in each page's style.css: `:root` is the dark
// (Ink + Violet) default, `:root[data-theme="light"]` is the companion light
// theme. This module only flips the attribute.

export type Theme = 'light' | 'dark';

const KEY = 'shotcache.theme';
const mq = window.matchMedia('(prefers-color-scheme: light)');

/** Apply the stored or system theme; track OS changes until the user pins one. */
export function initTheme(): void {
  apply(stored() ?? systemTheme());
  mq.addEventListener('change', () => {
    if (!stored()) apply(systemTheme());
  });
}

/** Flip and persist; returns the now-active theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(KEY, next);
  apply(next);
  return next;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function apply(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

function stored(): Theme | null {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

function systemTheme(): Theme {
  return mq.matches ? 'light' : 'dark';
}
