import { useCallback, useState } from 'react';
import {
  applyTheme,
  readThemePreference,
  STORAGE_KEY_THEME,
  type ThemePreference,
} from '../utils/theme';

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePreference>(readThemePreference);

  const setTheme = useCallback((pref: ThemePreference) => {
    setThemeState(pref);
    try {
      localStorage.setItem(STORAGE_KEY_THEME, pref);
    } catch {
      /* 写入失败忽略 */
    }
    applyTheme(pref);
  }, []);

  return { theme, setTheme };
}
