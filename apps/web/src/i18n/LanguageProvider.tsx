import { useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { I18nContext, translate, type Locale, type I18nContextValue } from './index';
import { api } from '../api/client';

interface Props {
  initialLocale?: Locale;
  children: ReactNode;
}

export function LanguageProvider({ initialLocale = 'zh', children }: Props) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // Set HTML lang attribute on mount and locale change
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
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
