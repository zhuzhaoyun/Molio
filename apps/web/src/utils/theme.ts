export type ThemePreference = 'system' | 'light' | 'dark';

export const STORAGE_KEY_THEME = 'molio.theme';

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_THEME);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage 不可用（如隐私模式）时回退默认 */
  }
  return 'system';
}

export function applyTheme(pref: ThemePreference): void {
  const el = document.documentElement;
  if (pref === 'dark') {
    el.setAttribute('data-theme', 'dark');
  } else if (pref === 'light') {
    el.setAttribute('data-theme', 'light');
  } else {
    el.removeAttribute('data-theme');
  }
}

/** 首次渲染前同步执行，避免主题闪烁。 */
export function initTheme(): void {
  applyTheme(readThemePreference());
}
