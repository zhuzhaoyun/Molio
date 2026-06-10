import { createContext, useContext } from 'react';
import zh from './locales/zh';
import en from './locales/en';

export type Locale = 'zh' | 'en';

const dictionaries: Record<Locale, Record<string, string>> = { zh, en };

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  setLocale: () => {},
  t: (key) => key,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function translate(
  locale: Locale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[locale] ?? dictionaries.zh;
  let value = dict[key] ?? dictionaries.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, String(v));
    }
  }
  return value;
}
