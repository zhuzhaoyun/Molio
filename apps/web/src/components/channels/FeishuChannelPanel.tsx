import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FeishuStatus } from '../../api/client';
import { useAgents } from '../../hooks/useAgents';
import { useChannelStatus } from '../../hooks/useChannelStatus';
import { useI18n } from '../../i18n';

const FEISHU_OPEN_BASE = 'https://open.feishu.cn/app';

/** Poll cadence + cap while waiting for the login window to report success. */
const LOGIN_POLL_INTERVAL_MS = 2000;
const LOGIN_POLL_MAX_MS = 120_000;

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

interface FeishuLoginInfo {
  loggedIn: boolean;
}

/** The subset of the Electron preload bridge this panel uses (absent in pure web/dev). */
interface ElectronBridge {
  openFeishuLogin?: (url?: string) => Promise<void>;
  getFeishuLoginStatus?: () => Promise<FeishuLoginInfo>;
}

function getElectron(): ElectronBridge | undefined {
  return (window as unknown as { __electron__?: ElectronBridge }).__electron__;
}

export function FeishuChannelPanel() {
  const { t } = useI18n();
  const { agents } = useAgents();
  const { status, busy, error, runAction } = useChannelStatus<FeishuStatus>(
    () => api.getFeishuStatus(),
  );
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [loginInfo, setLoginInfo] = useState<FeishuLoginInfo | null>(null);
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.getConfig()
      .then((config) => {
        const feishu = config.feishu as
          | { appId?: string; appSecret?: string; defaultAgentId?: string }
          | undefined;
        setAppId(feishu?.appId ?? '');
        setAppSecret(feishu?.appSecret ?? '');
        setDefaultAgentId(
          feishu?.defaultAgentId ?? (config.defaultAgentId as string | undefined) ?? '',
        );
      })
      .catch(() => {});
  }, []);

  const handleSave = useCallback(() => {
    void runAction(() => api.updateFeishuConfig({
      enabled: true,
      appId: appId.trim() || undefined,
      appSecret: appSecret.trim() || undefined,
      defaultAgentId: defaultAgentId || undefined,
    }));
  }, [appId, appSecret, defaultAgentId, runAction]);

  const handleStart = useCallback(() => {
    void runAction(() => api.startFeishu());
  }, [runAction]);

  const handleDisconnect = useCallback(() => {
    void runAction(() => api.disconnectFeishu());
  }, [runAction]);

  const stopLoginPoll = useCallback(() => {
    if (loginPollRef.current) {
      clearInterval(loginPollRef.current);
      loginPollRef.current = null;
    }
  }, []);

  const refreshLoginStatus = useCallback(async (): Promise<FeishuLoginInfo | null> => {
    const electron = getElectron();
    if (!electron?.getFeishuLoginStatus) return null;
    try {
      const info = await electron.getFeishuLoginStatus();
      setLoginInfo(info);
      return info;
    } catch {
      return null;
    }
  }, []);

  // Initial read + cleanup of any in-flight poll on unmount.
  useEffect(() => {
    void refreshLoginStatus();
    return () => stopLoginPoll();
  }, [refreshLoginStatus, stopLoginPoll]);

  const handleLogin = useCallback(() => {
    const electron = getElectron();
    if (!electron?.openFeishuLogin) {
      alert(t('channels.feishu.login.hint'));
      return;
    }
    void electron.openFeishuLogin();
    // Poll for login success (the login window auto-closes once detected); stop
    // once loggedIn flips true or after a cap so we don't poll forever.
    stopLoginPoll();
    const startedAt = Date.now();
    loginPollRef.current = setInterval(() => {
      void refreshLoginStatus().then((info) => {
        if (info?.loggedIn || Date.now() - startedAt > LOGIN_POLL_MAX_MS) stopLoginPoll();
      });
    }, LOGIN_POLL_INTERVAL_MS);
  }, [refreshLoginStatus, stopLoginPoll, t]);

  const loginStatus = status?.loginStatus ?? 'idle';
  const connected = !!status?.connected;
  const appIdLink = appId.trim() ? `${FEISHU_OPEN_BASE}/${appId.trim()}` : FEISHU_OPEN_BASE;

  return (
    <section className="channels-card channels-card--feishu">
      <div className="channels-card__main">
        <div className="channels-card__topline">
          <span className={`channels-dot ${connected ? 'is-connected' : ''}`} />
          <span className="channels-card__status">
            {t(`channels.feishu.status.${loginStatus}`)}
          </span>
        </div>

        <h2 className="channels-card__title">{t('channels.feishu.title')}</h2>
        <p className="channels-card__desc">{t('channels.feishu.longDesc')}</p>

        <div className="channels-feishu-wizard">
          <div className="channels-feishu-wizard__head">
            <h3 className="channels-feishu-wizard__title">{t('channels.feishu.wizard.title')}</h3>
            <p className="channels-feishu-wizard__subtitle">{t('channels.feishu.wizard.subtitle')}</p>
          </div>

          <ol className="channels-feishu-steps">
            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step1.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step1.desc')}</p>
              </div>
              <button
                type="button"
                className="rt-btn rt-btn--sm rt-btn--ghost"
                onClick={() => openUrl(FEISHU_OPEN_BASE)}
              >
                {t('channels.feishu.wizard.openApp')}
              </button>
            </li>

            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step2.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step2.desc')}</p>
                <div className="channels-feishu-credentials">
                  <label className="channels-field">
                    <span className="channels-field__label">{t('channels.feishu.appId')}</span>
                    <input
                      className="channels-input"
                      value={appId}
                      placeholder={t('channels.feishu.appIdPlaceholder')}
                      onChange={(e) => setAppId(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label className="channels-field">
                    <span className="channels-field__label">{t('channels.feishu.appSecret')}</span>
                    <input
                      className="channels-input"
                      type="password"
                      value={appSecret}
                      placeholder={t('channels.feishu.appSecretPlaceholder')}
                      onChange={(e) => setAppSecret(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="button"
                    className="rt-btn channels-feishu-save"
                    onClick={handleSave}
                    disabled={busy}
                  >
                    {t('channels.feishu.save')}
                  </button>
                </div>
              </div>
            </li>

            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step3.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step3.desc')}</p>
                <ul className="channels-feishu-perms">
                  <li><code>im:message</code> — {t('channels.feishu.wizard.step3.perm1')}</li>
                  <li><code>im:message:send_as_bot</code> — {t('channels.feishu.wizard.step3.perm2')}</li>
                  <li><code>im:resource</code> — {t('channels.feishu.wizard.step3.perm3')}</li>
                  <li><code>im:chat:readonly</code> — {t('channels.feishu.wizard.step3.perm4')}</li>
                </ul>
              </div>
              <button
                type="button"
                className="rt-btn rt-btn--sm rt-btn--ghost"
                onClick={() => openUrl(`${appIdLink}/permission`)}
              >
                {t('channels.feishu.wizard.openPermission')}
              </button>
            </li>

            <li className="channels-feishu-step channels-feishu-step--warn">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step4.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step4.desc')}</p>
                <ul className="channels-feishu-event">
                  <li>
                    <strong>{t('channels.feishu.wizard.eventSubscription.title')}</strong>
                    <div>{t('channels.feishu.wizard.eventSubscription.selectLongConn')}</div>
                    <div className="channels-feishu-warn">
                      {t('channels.feishu.wizard.eventSubscription.selectLongConnWarn')}
                    </div>
                  </li>
                  <li>{t('channels.feishu.wizard.eventSubscription.addReceiveMessageEvent')}</li>
                </ul>
              </div>
              <button
                type="button"
                className="rt-btn rt-btn--sm rt-btn--ghost"
                onClick={() => openUrl(`${appIdLink}/event`)}
              >
                {t('channels.feishu.wizard.openEvent')}
              </button>
            </li>

            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step5.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step5.desc')}</p>
              </div>
              <button
                type="button"
                className="rt-btn rt-btn--sm rt-btn--ghost"
                onClick={() => openUrl(`${appIdLink}/version`)}
              >
                {t('channels.feishu.wizard.openVersion')}
              </button>
            </li>

            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step6.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step6.desc')}</p>
                <label className="channels-field">
                  <span className="channels-field__label">{t('channels.feishu.defaultAgent')}</span>
                  <select
                    className="channels-select"
                    value={defaultAgentId}
                    onChange={(event) => setDefaultAgentId(event.target.value)}
                  >
                    <option value="">{t('channels.feishu.useAppDefault')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id} disabled={!agent.available}>
                        {agent.name}{agent.available ? '' : ` (${t('runtimes.unavailable')})`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>

            <li className="channels-feishu-step">
              <div className="channels-feishu-step__body">
                <h4 className="channels-feishu-step__title">{t('channels.feishu.wizard.step7.title')}</h4>
                <p className="channels-feishu-step__desc">{t('channels.feishu.wizard.step7.desc')}</p>
              </div>
            </li>
          </ol>
        </div>

        <div className="channels-feishu-login">
          <div className="channels-feishu-login__body">
            <h3 className="channels-feishu-login__title">
              {t('channels.feishu.login.title')}
              <span className="channels-badge" data-testid="feishu-login-optional-badge">
                {t('channels.feishu.login.optional')}
              </span>
            </h3>
            <p className="channels-feishu-login__desc">{t('channels.feishu.login.desc')}</p>
            <p className="channels-feishu-login__hint">{t('channels.feishu.login.hint')}</p>
            {loginInfo && (
              <div className="channels-feishu-login__status" data-testid="feishu-login-status">
                {loginInfo.loggedIn ? (
                  <span className="channels-feishu-login__status-on">
                    {t('channels.feishu.login.status.loggedIn')}
                  </span>
                ) : (
                  <span className="channels-feishu-login__status-off">
                    {t('channels.feishu.login.status.notLoggedIn')}
                  </span>
                )}
                <button
                  type="button"
                  className="rt-btn rt-btn--xs rt-btn--ghost"
                  data-testid="feishu-login-refresh-btn"
                  onClick={() => void refreshLoginStatus()}
                >
                  {t('channels.feishu.login.refresh')}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="rt-btn rt-btn--sm rt-btn--ghost"
            data-testid="feishu-login-btn"
            onClick={handleLogin}
          >
            {t('channels.feishu.login.button')}
          </button>
        </div>

        {status?.lastMessageAt && (
          <div className="channels-card__meta">
            {t('channels.feishu.lastMessage', { time: new Date(status.lastMessageAt).toLocaleString() })}
          </div>
        )}
        {status?.activeRunId && (
          <div className="channels-card__meta">
            {t('channels.feishu.activeRun', { runId: status.activeRunId })}
          </div>
        )}
        {(error || status?.lastError) && (
          <div className="channels-card__error">
            {error || status?.lastError}
          </div>
        )}
      </div>

      <div className="channels-card__side channels-card__side--feishu">
        <div className="channels-empty">
          {connected ? t('channels.feishu.connectedHint') : t('channels.feishu.noConfig')}
        </div>

        <div className="channels-actions">
          <button
            className="rt-btn rt-btn--sm"
            type="button"
            onClick={handleStart}
            disabled={busy || !appId.trim() || !appSecret.trim()}
          >
            {connected ? t('channels.feishu.reconnect') : t('channels.feishu.start')}
          </button>
          {(connected || status?.hasCredentials) && (
            <button
              className="rt-btn rt-btn--sm"
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
            >
              {t('channels.feishu.disconnect')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
