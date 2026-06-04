import { useEffect, useState, useCallback } from 'react';

type CheckResult =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'available'; currentVersion: string; latestVersion: string; downloading: boolean; percent: number }
  | { status: 'downloaded'; currentVersion: string; latestVersion: string }
  | { status: 'error'; message: string };

/**
 * Settings page — currently contains the version & update management panel.
 * Designed to work both in Electron (with window.updater) and in plain browser
 * (where update features are hidden).
 */
export function SettingsPage() {
  const [result, setResult] = useState<CheckResult>({ status: 'idle' });
  const currentVersion = window.__electron__?.appInfo?.version ?? 'dev';
  const isElectron = !!window.updater;

  // Listen for background updater events to reflect live state
  useEffect(() => {
    if (!window.updater) return;

    const cleanups: Array<() => void> = [];

    cleanups.push(
      window.updater.onUpdateAvailable((info) => {
        setResult((prev) => {
          if (prev.status === 'checking' || prev.status === 'idle') {
            return {
              status: 'available',
              currentVersion: window.__electron__?.appInfo?.version ?? 'dev',
              latestVersion: info.version,
              downloading: true,
              percent: 0,
            };
          }
          return prev;
        });
      })
    );

    cleanups.push(
      window.updater.onDownloadProgress((progress) => {
        setResult((prev) => {
          if (prev.status === 'available' && prev.downloading) {
            return { ...prev, percent: progress.percent };
          }
          return prev;
        });
      })
    );

    cleanups.push(
      window.updater.onUpdateDownloaded((info) => {
        setResult({
          status: 'downloaded',
          currentVersion: window.__electron__?.appInfo?.version ?? 'dev',
          latestVersion: info.version,
        });
      })
    );

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const handleCheck = useCallback(async () => {
    if (!window.updater) return;
    setResult({ status: 'checking' });
    const res = await window.updater.checkForUpdates();
    if (!res.ok) {
      setResult({ status: 'error', message: res.error });
      return;
    }
    if (!res.available) {
      setResult({ status: 'up-to-date', currentVersion: res.currentVersion });
    }
    // If available, the onUpdateAvailable listener will update the state.
    // Keep 'checking' until that event fires.
  }, []);

  return (
    <div className="settings-shell">
      {/* Header */}
      <div className="settings-header">
        <h1 className="settings-header__title">设置</h1>
      </div>

      {/* Update section */}
      <div className="settings-content">
        <section className="settings-section">
          <h2 className="rt-section-title">版本与更新</h2>
          <div className="settings-update-card">
            <div className="settings-update-card__info">
              <div className="settings-update-card__version-row">
                <span className="settings-update-card__label">当前版本</span>
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
                  更新功能仅在桌面客户端可用
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
                下载中 {Math.round(result.percent)}%
              </span>
            </div>
          )}

          {/* Downloaded — ready to install */}
          {result.status === 'downloaded' && (
            <div className="settings-ready">
              <span className="settings-ready__text">
                v{result.latestVersion} 已下载，重启后应用更新
              </span>
              <button
                className="rt-btn rt-btn--sm settings-ready__btn"
                onClick={() => window.updater?.installUpdate()}
              >
                立即重启
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function UpdateStatus({ result }: { result: CheckResult }) {
  switch (result.status) {
    case 'idle':
      return null;
    case 'checking':
      return (
        <span className="settings-update-card__status settings-update-card__status--checking">
          <span className="settings-spinner" />
          正在检查更新…
        </span>
      );
    case 'up-to-date':
      return (
        <span className="settings-update-card__status settings-update-card__status--ok">
          ✓ 已是最新版本
        </span>
      );
    case 'available':
      return (
        <span className="settings-update-card__status settings-update-card__status--new">
          发现新版本 v{result.latestVersion}
        </span>
      );
    case 'downloaded':
      return (
        <span className="settings-update-card__status settings-update-card__status--ready">
          ✓ 更新已下载
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
  const disabled = result.status === 'checking' || (result.status === 'available' && result.downloading);

  return (
    <button
      className="rt-btn rt-btn--sm"
      onClick={onCheck}
      disabled={disabled}
    >
      {result.status === 'checking' ? '检查中…' : '检查更新'}
    </button>
  );
}
