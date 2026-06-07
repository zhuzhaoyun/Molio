import { useEffect, useState, useCallback } from 'react';
import {
  type CheckResult,
  onUpdateAvailable,
  onDownloadProgress,
  onUpdateDownloaded,
  onUpdateError,
  onCheckResult,
} from './updater-state';

export type { CheckResult } from './updater-state';

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

    const cv = currentVersion;
    const cleanups: Array<() => void> = [];

    cleanups.push(
      window.updater.onUpdateAvailable((info) => {
        setResult((prev) => onUpdateAvailable(prev, info, cv));
      })
    );

    cleanups.push(
      window.updater.onDownloadProgress((progress) => {
        setResult((prev) => onDownloadProgress(prev, progress));
      })
    );

    cleanups.push(
      window.updater.onUpdateDownloaded((info) => {
        setResult((prev) => onUpdateDownloaded(prev, info, cv));
      })
    );

    // Surface background updater errors (network failures, etc.)
    cleanups.push(
      window.updater.onUpdateError((info) => {
        setResult((prev) => onUpdateError(prev, info));
      })
    );

    return () => cleanups.forEach((fn) => fn());
  }, [currentVersion]);

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
