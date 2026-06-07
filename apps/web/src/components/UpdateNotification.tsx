import { useEffect, useState } from 'react';

type UpdateState =
  | { status: 'idle' }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

/**
 * Fixed-position toast that appears when an update has been downloaded
 * and is ready to install, or when an update error occurs.
 * Only renders in Electron (packaged) mode.
 */
export function UpdateNotification() {
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

    cleanups.push(
      window.updater.onUpdateError((info) => {
        setState({ status: 'error', message: info.message });
        setDismissed(false);
      })
    );

    return () => cleanups.forEach((fn) => fn());
  }, []);

  if (!window.updater) return null;
  if (state.status === 'idle' || dismissed) return null;

  if (state.status === 'error') {
    return (
      <div className="update-toast update-toast--error">
        <button
          className="update-toast__close"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          ✕
        </button>
        <p className="update-toast__title">更新检测失败</p>
        <p className="update-toast__subtitle update-toast__subtitle--error">
          {state.message}
        </p>
        <div className="update-toast__actions">
          <button
            className="rt-btn rt-btn--sm"
            onClick={() => setDismissed(true)}
          >
            关闭
          </button>
          <button
            className="rt-btn rt-btn--sm update-toast__primary"
            onClick={() => {
              window.updater?.checkForUpdates();
              setDismissed(true);
            }}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

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
