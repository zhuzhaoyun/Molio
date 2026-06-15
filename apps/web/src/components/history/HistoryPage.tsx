import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationHistoryItem } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

export function HistoryPage({ onOpenConversation }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeItem = useMemo(
    () => items.find((item) => item.conversation.id === activeId) ?? items[0] ?? null,
    [activeId, items],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.listConversationHistory();
      setItems(next);
      setActiveId((current) => {
        if (current && next.some((item) => item.conversation.id === current)) return current;
        return next[0]?.conversation.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(async (conversationId: string) => {
    await api.deleteConversationById(conversationId);
    await refresh();
  }, [refresh]);

  return (
    <div className="history-shell">
      <header className="history-header">
        <div className="history-header__left">
          <h1 className="history-header__title">{t('history.title')}</h1>
          <span className="history-header__subtitle">{t('history.count', { count: items.length })}</span>
        </div>
        <button className="rt-btn rt-btn--sm" type="button" onClick={refresh} disabled={loading}>
          {loading ? t('history.loading') : t('history.refresh')}
        </button>
      </header>

      {error && <div className="history-error">{error}</div>}

      {loading && items.length === 0 ? (
        <div className="rt-loading">{t('history.loading')}</div>
      ) : items.length === 0 ? (
        <div className="rt-empty">
          <div className="rt-empty__text">{t('history.empty')}</div>
          <div className="rt-empty__hint">{t('history.emptyHint')}</div>
        </div>
      ) : (
        <div className="history-layout">
          <aside className="history-list" aria-label={t('history.listLabel')}>
            {items.map((item) => (
              <HistoryListItem
                key={item.conversation.id}
                item={item}
                active={item.conversation.id === activeItem?.conversation.id}
                onSelect={() => setActiveId(item.conversation.id)}
              />
            ))}
          </aside>

          <main className="history-detail">
            {activeItem && (
              <HistoryDetail
                item={activeItem}
                onOpen={() => onOpenConversation(activeItem.conversation.id)}
                onDelete={() => void handleDelete(activeItem.conversation.id)}
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function HistoryListItem({
  item,
  active,
  onSelect,
}: {
  item: ConversationHistoryItem;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const { conversation, lastMessage, messageCount } = item;

  return (
    <button
      type="button"
      className={`history-item${active ? ' is-active' : ''}`}
      onClick={onSelect}
    >
      <span className="history-item__main">
        <span className="history-item__top">
          <span className="history-item__title">{conversation.title || t('history.untitled')}</span>
          <span className={`history-source history-source--${conversation.channelType ?? 'desktop'}`}>
            {sourceLabel(t, conversation.channelType)}
          </span>
        </span>
        <span className="history-item__preview">
          {lastMessage?.content || t('history.noMessage')}
        </span>
      </span>
      <span className="history-item__meta">
        <span>{formatTime(conversation.updatedAt)}</span>
        <span>{t('history.messageCount', { count: messageCount })}</span>
      </span>
    </button>
  );
}

function HistoryDetail({
  item,
  onOpen,
  onDelete,
}: {
  item: ConversationHistoryItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { conversation, lastMessage, messageCount } = item;

  return (
    <section className="history-detail-card">
      <div className="history-detail-card__head">
        <div className="history-detail-card__title-block">
          <span className={`history-source history-source--${conversation.channelType ?? 'desktop'}`}>
            {sourceLabel(t, conversation.channelType)}
          </span>
          <h2>{conversation.title || t('history.untitled')}</h2>
        </div>
        <div className="history-detail-card__actions">
          <button className="rt-btn rt-btn--sm" type="button" onClick={onOpen}>
            {t('history.open')}
          </button>
          <button className="rt-btn rt-btn--sm rt-btn--ghost" type="button" onClick={onDelete}>
            {t('history.delete')}
          </button>
        </div>
      </div>

      <dl className="history-detail-meta">
        <div>
          <dt>{t('history.updatedAt')}</dt>
          <dd>{new Date(conversation.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t('history.messages')}</dt>
          <dd>{messageCount}</dd>
        </div>
        {conversation.externalSessionId && (
          <div>
            <dt>{t('history.externalSession')}</dt>
            <dd>{conversation.externalSessionId}</dd>
          </div>
        )}
      </dl>

      <div className="history-last-message">
        <div className="history-last-message__label">{t('history.lastMessage')}</div>
        <div className="history-last-message__body">
          {lastMessage?.content || t('history.noMessage')}
        </div>
      </div>
    </section>
  );
}

function sourceLabel(t: (key: string, params?: Record<string, string | number>) => string, channelType?: string) {
  if (channelType === 'weixin') return t('history.source.weixin');
  if (channelType === 'feishu') return t('history.source.feishu');
  if (channelType === 'wecom') return t('history.source.wecom');
  return t('history.source.desktop');
}

function formatTime(value: number) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString();
}
