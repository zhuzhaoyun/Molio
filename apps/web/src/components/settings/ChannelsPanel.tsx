import { useCallback, useEffect, useState } from 'react';
import { api, type WeixinStatus } from '../../api/client';
import { useAgents } from '../../hooks/useAgents';
import { useI18n } from '../../i18n';

type ChannelId = 'weixin' | 'feishu' | 'wecom';

interface ChannelItem {
  id: ChannelId;
  titleKey: string;
  descKey: string;
  statusKey: string;
  available: boolean;
}

const CHANNELS: ChannelItem[] = [
  {
    id: 'weixin',
    titleKey: 'channels.weixin.title',
    descKey: 'channels.weixin.desc',
    statusKey: 'channels.status.available',
    available: true,
  },
  {
    id: 'feishu',
    titleKey: 'channels.feishu.title',
    descKey: 'channels.feishu.desc',
    statusKey: 'channels.status.planned',
    available: false,
  },
  {
    id: 'wecom',
    titleKey: 'channels.wecom.title',
    descKey: 'channels.wecom.desc',
    statusKey: 'channels.status.planned',
    available: false,
  },
];

function PlannedChannelPanel({ channel }: { channel: ChannelItem }) {
  const { t } = useI18n();

  return (
    <section className="channels-card channels-card--empty">
      <div>
        <h2 className="channels-card__title">{t(channel.titleKey)}</h2>
        <p className="channels-card__desc">{t(channel.descKey)}</p>
      </div>
      <span className="channels-empty-state">{t('channels.comingSoon')}</span>
    </section>
  );
}

function WeixinChannelPanel() {
  const { t } = useI18n();
  const { agents } = useAgents();
  const [status, setStatus] = useState<WeixinStatus | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await api.getWeixinStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await api.getWeixinStatus();
        if (!stopped) setStatus(next);
      } catch {
        // keep the previous status visible
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
        const weixin = config.weixin as { defaultAgentId?: string } | undefined;
        setDefaultAgentId(weixin?.defaultAgentId ?? (config.defaultAgentId as string | undefined) ?? '');
      })
      .catch(() => {});
  }, []);

  const runAction = useCallback(async (fn: () => Promise<WeixinStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

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

export function ChannelsPanel() {
  const { t } = useI18n();
  const [active, setActive] = useState<ChannelId>('weixin');
  const activeChannel = CHANNELS.find((channel) => channel.id === active) ?? CHANNELS[0];

  return (
    <div className="channels-shell">
      <div className="channels-header">
        <h1 className="channels-header__title">{t('channels.title')}</h1>
      </div>

      <div className="channels-layout">
        <aside className="channels-list" aria-label={t('channels.listLabel')}>
          {CHANNELS.map((channel) => (
            <button
              key={channel.id}
              type="button"
              className={`channels-list__item${active === channel.id ? ' is-active' : ''}`}
              onClick={() => setActive(channel.id)}
            >
              <span className="channels-list__item-main">
                <span className="channels-list__item-title">{t(channel.titleKey)}</span>
                <span className="channels-list__item-desc">{t(channel.descKey)}</span>
              </span>
              <span className={`channels-badge${channel.available ? ' channels-badge--on' : ''}`}>
                {t(channel.statusKey)}
              </span>
            </button>
          ))}
        </aside>

        <main className="channels-panel">
          {activeChannel.id === 'weixin' ? (
            <WeixinChannelPanel />
          ) : (
            <PlannedChannelPanel channel={activeChannel} />
          )}
        </main>
      </div>
    </div>
  );
}
