import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

type UpdateState =
  | { status: 'idle' }
  | { status: 'ready'; version: string };

/**
 * Fixed-position toast that appears when an update has been downloaded
 * and is ready to install.
 *
 * Background update-check errors (network timeouts, etc.) are intentionally
 * NOT shown as a toast — they are surfaced in the Settings page instead.
 * This avoids intrusive popups when the user is already up-to-date but
 * the GitHub endpoint is unreachable (common in some network environments).
 *
 * Only renders in Electron (packaged) mode.
 */
export function UpdateNotification() {
  const { t } = useI18n();
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.updater) return;

    const cleanups: (() => void)[] = [];

    cleanups.push(
      window.updater.onUpdateDownloaded((info) => {
        setState({ status: 'ready', version: info.version });
        setDismissed(false);
      })
    );

    // Background errors are NOT shown as toast — see Settings page for error UI

    return () => cleanups.forEach((fn) => fn());
  }, []);

  if (!window.updater) return null;
  if (state.status === 'idle' || dismissed) return null;

  return (
    <div className="update-toast">
      <button
        className="update-toast__close"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        ✕
      </button>
      <p className="update-toast__title">{t('update.ready')}</p>
      <p className="update-toast__subtitle">
        {t('update.willApply', { version: state.version })}
      </p>
      <div className="update-toast__actions">
        <button
          className="rt-btn rt-btn--sm"
          onClick={() => setDismissed(true)}
        >
          {t('update.later')}
        </button>
        <button
          className="rt-btn rt-btn--sm update-toast__primary"
          onClick={() => window.updater?.installUpdate()}
        >
          {t('update.restartNow')}
        </button>
      </div>
    </div>
  );
}
