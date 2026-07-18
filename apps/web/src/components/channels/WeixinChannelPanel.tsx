import { useCallback, useEffect, useState } from 'react';
import { api, type WeixinStatus } from '../../api/client';
import { useAgents } from '../../hooks/useAgents';
import { useChannelStatus } from '../../hooks/useChannelStatus';
import { useI18n } from '../../i18n';

/**
 * Weixin channel panel — QR login + polling status + default agent picker.
 * Extracted from ChannelsPanel.tsx so it sits symmetrically with
 * FeishuChannelPanel under components/channels/.
 */
export function WeixinChannelPanel() {
  const { t } = useI18n();
  const { agents } = useAgents();
  const { status, busy, error, runAction } = useChannelStatus<WeixinStatus>(
    () => api.getWeixinStatus(),
  );
  const [defaultAgentId, setDefaultAgentId] = useState('');

  useEffect(() => {
    api.getConfig()
      .then((config) => {
        const weixin = config.weixin as { defaultAgentId?: string } | undefined;
        setDefaultAgentId(weixin?.defaultAgentId ?? (config.defaultAgentId as string | undefined) ?? '');
      })
      .catch(() => {});
  }, []);

  const handleLogin = useCallback(() => {
    void runAction(async () => {
      if (defaultAgentId) {
        await api.updateWeixinConfig({ enabled: true, defaultAgentId });
      }
      return api.beginWeixinLogin();
    });
  }, [defaultAgentId, runAction]);

  const handleSaveAgent = useCallback(() => {
    void runAction(() => api.updateWeixinConfig({ enabled: true, defaultAgentId }));
  }, [defaultAgentId, runAction]);

  const handleDisconnect = useCallback(() => {
    void runAction(() => api.disconnectWeixin());
  }, [runAction]);

  const loginStatus = status?.loginStatus ?? 'idle';
  const connected = !!status?.connected;

  return (
    <section className="channels-card">
      <div className="channels-card__main">
        <div className="channels-card__topline">
          <span className={`channels-dot ${connected ? 'is-connected' : ''}`} />
          <span className="channels-card__status">
            {t(`channels.weixin.status.${loginStatus}`)}
          </span>
        </div>

        <h2 className="channels-card__title">{t('channels.weixin.title')}</h2>
        <p className="channels-card__desc">{t('channels.weixin.longDesc')}</p>

        <label className="channels-field">
          <span className="channels-field__label">{t('channels.weixin.defaultAgent')}</span>
          <select
            className="channels-select"
            value={defaultAgentId}
            onChange={(event) => setDefaultAgentId(event.target.value)}
          >
            <option value="">{t('channels.weixin.useAppDefault')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={!agent.available}>
                {agent.name}{agent.available ? '' : ` (${t('runtimes.unavailable')})`}
              </option>
            ))}
          </select>
        </label>

        {status?.lastMessageAt && (
          <div className="channels-card__meta">
            {t('channels.weixin.lastMessage', { time: new Date(status.lastMessageAt).toLocaleString() })}
          </div>
        )}
        {status?.activeRunId && (
          <div className="channels-card__meta">
            {t('channels.weixin.activeRun', { runId: status.activeRunId })}
          </div>
        )}
        {(error || status?.lastError) && (
          <div className="channels-card__error">
            {error || status?.lastError}
          </div>
        )}
      </div>

      <div className="channels-card__side">
        {status?.qrcodeUrl ? (
          <div className="channels-qr">
            <img src={status.qrcodeUrl} alt={t('channels.weixin.qrAlt')} />
            <span>{t('channels.weixin.scanHint')}</span>
          </div>
        ) : (
          <div className="channels-empty">
            {connected ? t('channels.weixin.connectedHint') : t('channels.weixin.noQr')}
          </div>
        )}

        <div className="channels-actions">
          <button className="rt-btn rt-btn--sm" type="button" onClick={handleLogin} disabled={busy}>
            {connected ? t('channels.weixin.reconnect') : t('channels.weixin.connect')}
          </button>
          <button className="rt-btn rt-btn--sm" type="button" onClick={handleSaveAgent} disabled={busy}>
            {t('common.save')}
          </button>
          {(connected || status?.hasCredentials) && (
            <button className="rt-btn rt-btn--sm" type="button" onClick={handleDisconnect} disabled={busy}>
              {t('channels.weixin.disconnect')}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
