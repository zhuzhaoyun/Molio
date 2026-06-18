import { useI18n } from '../../i18n';

const LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
] as const;

export function LanguageSettings() {
  const { t, locale, setLocale } = useI18n();

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.language')}</h2>
      <div className="settings-language-card">
        <div className="settings-lang-pills">
          {LANG_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`settings-lang-pill${locale === opt.value ? ' is-active' : ''}`}
              onClick={() => setLocale(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
