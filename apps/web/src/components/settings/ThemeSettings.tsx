import { useI18n } from '../../i18n';
import { useTheme } from '../../hooks/useTheme';
import type { ThemePreference } from '../../utils/theme';

const THEME_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
];

export function ThemeSettings() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.theme')}</h2>
      <div className="settings-choice-card">
        <div className="settings-choice-pills">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              data-testid={`theme-${opt.value}`}
              className={`settings-choice-pill${theme === opt.value ? ' is-active' : ''}`}
              onClick={() => setTheme(opt.value)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
