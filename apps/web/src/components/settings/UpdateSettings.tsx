import { useEffect, useState, useCallback } from 'react';
import {
  type CheckResult,
  fromUpdaterState,
  onCheckResult,
} from './updater-state';
import { useI18n } from '../../i18n';
import {
  ExternalLinkIcon,
  FileIcon,
  GitHubIcon,
  GlobeIcon,
  RefreshIcon,
  StarIcon,
} from '../icons';

// 品牌 logo（public/images/main.png）—— 与 HomePage 同一副本
const LOGO_MAIN_URL = `${import.meta.env.BASE_URL}images/main.png`;

const SITE_URL = 'https://molio.cn';
const REPO_URL = 'https://github.com/zhuzhaoyun/Molio';
const RELEASES_URL = `${REPO_URL}/releases`;

export function UpdateSettings() {
  const { t } = useI18n();
  const [result, setResult] = useState<CheckResult>({ status: 'idle' });
  const currentVersion = window.__electron__?.appInfo?.version ?? 'dev';
  const isElectron = !!window.updater;

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

  // 已知具体版本时把更新日志直接锚到那个 release tag，否则落在索引页
  const knownLatest = 'latestVersion' in result ? result.latestVersion : null;
  const changelogUrl = knownLatest ? `${RELEASES_URL}/tag/v${knownLatest}` : RELEASES_URL;

  return (
    <section className="settings-section">
      <h2 className="rt-section-title">{t('settings.versionSection')}</h2>
      <div className="settings-update-card">
        <div className="settings-update-card__info">
          <div className="settings-update-card__brand">
            <img className="settings-update-card__logo" src={LOGO_MAIN_URL} alt="" />
            <span className="settings-update-card__name">Molio</span>
          </div>
          <div className="settings-update-card__version-row">
            <span className="settings-update-card__label">{t('settings.currentVersion')}</span>
            <span className="settings-update-card__version">v{currentVersion}</span>
            <UpdateStatus result={result} />
          </div>
        </div>

        <div className="settings-update-card__actions">
          <a
            className="settings-update-card__link"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="update-link-github"
          >
            <GitHubIcon size={14} />
            {t('settings.github')}
          </a>
          <a
            className="settings-update-card__link"
            href={SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="update-link-site"
          >
            <GlobeIcon size={14} />
            {t('settings.homepage')}
          </a>
          <a
            className="settings-update-card__link"
            href={changelogUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="update-link-changelog"
          >
            <FileIcon size={14} />
            {t('settings.changelog')}
          </a>
          {isElectron ? (
            <UpdateButton result={result} onCheck={handleCheck} />
          ) : (
            <span className="settings-update-card__hint" data-testid="update-desktop-only">
              {t('settings.desktopOnly')}
            </span>
          )}
        </div>

        {/*
         * Star 引导条：形态取自卡片页脚而非正文中部 —— 「顺便帮个忙」应该排在读完之后，
         * 不该插在版本号和按钮之间打断主任务。整条即链接（比只让末尾几个字可点更好点中）。
         */}
        <a
          className="settings-update-card__star"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="update-star-cta"
        >
          <StarIcon size={15} className="settings-update-card__star-icon" />
          {t('settings.starCta')}
          <ExternalLinkIcon size={13} className="settings-update-card__star-go" />
        </a>
      </div>

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
    </section>
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
    // 已就绪与安装中统一落到「重启后生效」，重启入口就是右侧那颗主按钮
    case 'downloaded':
      return (
        <span className="settings-update-card__status settings-update-card__status--ready">
          ✓ {t('settings.readyText', { version: result.latestVersion })}
        </span>
      );
    case 'installing':
      return (
        <span className="settings-update-card__status settings-update-card__status--ready">
          {t('settings.readyText', { version: result.latestVersion })}
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

/**
 * 卡片唯一的主动作 —— 文案、图标、点击行为三者都跟随真实状态。
 *
 * 之所以不写死「检查更新」：autoDownload 是开着的，点它实际是「检查 + 自动下载」；
 * 更新一旦下载完，这个位置就该换成「立即重启」。按钮说清楚它此刻做什么，
 * 卡片里就始终只有一个值得点的东西（否则会和下方面板的「立即重启」抢焦点）。
 * 转动的图标是同一件事的视觉冗余，用于在文案刷新前先给出「正在进行」的信号。
 */
function UpdateButton({
  result,
  onCheck,
}: {
  result: CheckResult;
  onCheck: () => void;
}) {
  const { t } = useI18n();

  const downloading = result.status === 'available' && result.downloading;
  // 已知有新版本但尚未开下载（主进程 updater.js 会以 available:true + downloading:false 上报）。
  // 此时再叫「检查更新」就是让按钮说谎 —— 检查已经做完了，缺的是下载。
  const awaitingDownload = result.status === 'available' && !result.downloading;
  const installing = result.status === 'installing';
  const ready = result.status === 'downloaded' || installing;
  const busy = result.status === 'checking' || installing || downloading;

  const label = ready
    ? t('settings.restartNow')
    : downloading
      ? t('settings.downloadingShort')
      : awaitingDownload
        ? t('settings.downloadUpdate')
        : result.status === 'checking'
          ? t('settings.checking')
          : t('settings.checkUpdate');

  return (
    <button
      className="rt-btn settings-update-card__action primary"
      onClick={ready && !installing ? () => window.updater?.installUpdate() : onCheck}
      disabled={busy}
      data-testid="update-check-btn"
    >
      <RefreshIcon size={14} className={busy ? 'is-spinning' : undefined} />
      {label}
    </button>
  );
}
