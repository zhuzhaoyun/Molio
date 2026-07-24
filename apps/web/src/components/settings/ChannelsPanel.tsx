import { useState } from 'react';
import { useI18n } from '../../i18n';
import { FeishuChannelPanel } from '../channels/FeishuChannelPanel';
import { WeixinChannelPanel } from '../channels/WeixinChannelPanel';

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
    statusKey: 'channels.status.available',
    available: true,
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
          ) : activeChannel.id === 'feishu' ? (
            <FeishuChannelPanel />
          ) : (
            <PlannedChannelPanel channel={activeChannel} />
          )}
        </main>
      </div>
    </div>
  );
}
