import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react';
import { I18nContext, translate, type Locale, type I18nContextValue } from './index';
import { api } from '../api/client';

interface Props {
  initialLocale?: Locale;
  children: ReactNode;
}

const LOCALE_STORAGE_KEY = 'molio.locale';

export function LanguageProvider({ initialLocale = 'zh', children }: Props) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  /**
   * 用户手动选过语言后「锁定」：initialLocale 之后随 config 快照异步到达/变化
   * （App 已去掉 configLoaded 白屏 gate，首帧用 localStorage 兜底），若不在
   * 用户显式选择后停止跟随，慢速 refresh 返回的旧值会把刚点的语言翻回去。
   */
  const userPinnedRef = useRef(false);

  // Follow late-arriving initialLocale (daemon config snapshot) until the
  // user explicitly picks a language.
  useEffect(() => {
    if (!userPinnedRef.current) setLocaleState(initialLocale);
  }, [initialLocale]);

  // Set HTML lang attribute on mount and locale change
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    userPinnedRef.current = true;
    setLocaleState(newLocale);
    // Persist for the next cold start's first paint (before config arrives).
    try { localStorage.setItem(LOCALE_STORAGE_KEY, newLocale); } catch { /* ignore */ }
    api.updateConfig({ locale: newLocale }).catch(() => {});
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
