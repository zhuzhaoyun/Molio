import { useI18n } from '../../i18n';

const LANG_OPTIONS = [
  { value: 'zh', label: '中文', testid: 'lang-zh' },
  { value: 'en', label: 'English', testid: 'lang-en' },
] as const;

export function LanguageSettings() {
  const { t, locale, setLocale } = useI18n();

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.language')}</h2>
      <div className="settings-choice-card">
        <div className="settings-choice-pills">
          {LANG_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={opt.testid}
              className={`settings-choice-pill${locale === opt.value ? ' is-active' : ''}`}
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
