import { useEffect, useState } from 'react';

type UpdateState =
  | { status: 'idle' }
  | { status: 'ready'; version: string };

/**
 * Fixed-position toast that appears when an update has been downloaded
 * and is ready to install. Only renders in Electron (packaged) mode.
 */
export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.updater) return;
    const cleanup = window.updater.onUpdateDownloaded((info) => {
      setState({ status: 'ready', version: info.version });
      setDismissed(false);
    });
    return cleanup;
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
      <p className="update-toast__title">更新就绪</p>
      <p className="update-toast__subtitle">
        v{state.version} 将在重启后应用
      </p>
      <div className="update-toast__actions">
        <button
          className="rt-btn rt-btn--sm"
          onClick={() => setDismissed(true)}
        >
          稍后
        </button>
        <button
          className="rt-btn rt-btn--sm update-toast__primary"
          onClick={() => window.updater?.installUpdate()}
        >
          立即重启
        </button>
      </div>
    </div>
  );
}
