import { useEffect, useState, useCallback } from 'react';
import {
  type CheckResult,
  fromUpdaterState,
  onCheckResult,
} from './updater-state';
import { useI18n } from '../../i18n';

export type { CheckResult } from './updater-state';

/**
 * Settings page — language selector + version & update management panel.
 * Designed to work both in Electron (with window.updater) and in plain browser
 * (where update features are hidden).
 */
export function SettingsPage() {
  const { t } = useI18n();
  const [result, setResult] = useState<CheckResult>({ status: 'idle' });
  const currentVersion = window.__electron__?.appInfo?.version ?? 'dev';
  const isElectron = !!window.updater;

  // Query current updater state first, then subscribe to changes. This keeps
  // Settings accurate even if the update was downloaded before React mounted.
  useEffect(() => {
    if (!window.updater) return;

    let disposed = false;
    window.updater.getState().then((state) => {
      if (!disposed) setResult(fromUpdaterState(state));
    });

    const cleanup = window.updater.onStateChanged((state) => {
      setResult(fromUpdaterState(state));
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const handleCheck = useCallback(async () => {
    if (!window.updater) return;
    setResult({ status: 'checking' });
    const res = await window.updater.checkForUpdates();
    setResult((prev) => onCheckResult(prev, res));
  }, []);

  return (
    <div className="settings-shell">
      {/* Header */}
      <div className="settings-header">
        <h1 className="settings-header__title">{t('settings.title')}</h1>
      </div>

      {/* Content */}
      <div className="settings-content">
        {/* Language section */}
        <section className="settings-section">
          <h2 className="rt-section-title">{t('settings.language')}</h2>
          <div className="settings-language-card">
            <LanguageSelector />
          </div>
        </section>

        {/* Update section */}
        <section className="settings-section">
          <h2 className="rt-section-title">{t('settings.versionSection')}</h2>
          <div className="settings-update-card">
            <div className="settings-update-card__info">
              <div className="settings-update-card__version-row">
                <span className="settings-update-card__label">{t('settings.currentVersion')}</span>
                <span className="settings-update-card__version">
                  v{currentVersion}
                </span>
              </div>
              <UpdateStatus result={result} />
            </div>
            <div className="settings-update-card__actions">
              {isElectron && (
                <UpdateButton result={result} onCheck={handleCheck} />
              )}
              {!isElectron && (
                <span className="settings-update-card__hint">
                  {t('settings.desktopOnly')}
                </span>
              )}
            </div>
          </div>

          {/* Download progress bar */}
          {result.status === 'available' && result.downloading && (
            <div className="settings-progress">
              <div
                className="settings-progress__bar"
                style={{ width: `${Math.round(result.percent)}%` }}
              />
              <span className="settings-progress__label">
                {t('settings.downloading', { percent: String(Math.round(result.percent)) })}
              </span>
            </div>
          )}

          {/* Downloaded — ready to install */}
          {result.status === 'downloaded' && (
            <div className="settings-ready">
              <span className="settings-ready__text">
                {t('settings.readyText', { version: result.latestVersion })}
              </span>
              <button
                className="rt-btn rt-btn--sm settings-ready__btn"
                onClick={() => window.updater?.installUpdate()}
              >
                {t('settings.restartNow')}
              </button>
            </div>
          )}

          {result.status === 'installing' && (
            <div className="settings-ready">
              <span className="settings-ready__text">
                {t('settings.readyText', { version: result.latestVersion })}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const LANG_OPTIONS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
] as const;

function LanguageSelector() {
  const { locale, setLocale } = useI18n();

  return (
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
  );
}

function UpdateStatus({ result }: { result: CheckResult }) {
  const { t } = useI18n();

  switch (result.status) {
    case 'idle':
      return null;
    case 'checking':
      return (
        <span className="settings-update-card__status settings-update-card__status--checking">
          <span className="settings-spinner" />
          {t('settings.isChecking')}
        </span>
      );
    case 'up-to-date':
      return (
        <span className="settings-update-card__status settings-update-card__status--ok">
          ✓ {t('settings.upToDate')}
        </span>
      );
    case 'available':
      return (
        <span className="settings-update-card__status settings-update-card__status--new">
          {t('settings.newVersion', { version: result.latestVersion })}
        </span>
      );
    case 'downloaded':
      return (
        <span className="settings-update-card__status settings-update-card__status--ready">
          ✓ {t('settings.downloaded')}
        </span>
      );
    case 'installing':
      return (
        <span className="settings-update-card__status settings-update-card__status--checking">
          <span className="settings-spinner" />
          {t('settings.checking')}
        </span>
      );
    case 'error':
      return (
        <span className="settings-update-card__status settings-update-card__status--error">
          ✗ {result.message}
        </span>
      );
  }
}

function UpdateButton({
  result,
  onCheck,
}: {
  result: CheckResult;
  onCheck: () => void;
}) {
  const { t } = useI18n();
  const disabled =
    result.status === 'checking' ||
    result.status === 'installing' ||
    (result.status === 'available' && result.downloading);

  return (
    <button
      className="rt-btn rt-btn--sm"
      onClick={onCheck}
      disabled={disabled}
    >
      {result.status === 'checking' ? t('settings.checking') : t('settings.checkUpdate')}
    </button>
  );
}
