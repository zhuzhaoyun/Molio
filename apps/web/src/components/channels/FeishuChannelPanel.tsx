import { useCallback, useEffect, useState } from 'react';
import { api, type FeishuStatus } from '../../api/client';
import { useAgents } from '../../hooks/useAgents';
import { useI18n } from '../../i18n';

const FEISHU_OPEN_BASE = 'https://open.feishu.cn/app';

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function FeishuChannelPanel() {
  const { t } = useI18n();
  const { agents } = useAgents();
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await api.getFeishuStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.getFeishuStatus();
        if (!stopped) setStatus(next);
      } catch {
        // keep previous status visible
      }
    };
    void tick();
    const timer = window.setInterval(tick, 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

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

  const runAction = useCallback(async (fn: () => Promise<FeishuStatus>) => {
    setBusy(true);
    setError(null);
    try {
      // `fn` already returns the updated status — no need for a follow-up
      // `refresh()` fetch (it would just re-set the same state + add latency).
      setStatus(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
                </div>
                <div className="channels-feishu-credentials-actions">
                  <button
                    type="button"
                    className="rt-btn rt-btn--sm"
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
