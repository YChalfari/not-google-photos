export type ThemeName = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'ngp-theme';

const PAPER = '#f3efe4';
const CHARCOAL = '#161410';

/** Missing or unreadable storage means dark, including on the signed-out screens. */
export function readTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? PAPER : CHARCOAL);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing can reject storage. The class still applies for this visit.
  }
}
