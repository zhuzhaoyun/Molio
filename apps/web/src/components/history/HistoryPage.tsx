import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationHistoryItem } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

interface HistoryGroup {
  key: string;
  label: string;
  items: ConversationHistoryItem[];
}

export function HistoryPage({ onOpenConversation }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listConversationHistory());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => groupByDate(items), [items]);

  return (
    <div className="history-shell">
      <header className="history-topbar">
        <div className="history-tabs" aria-label={t('history.tabsLabel')}>
          <button type="button" className="history-tab is-muted" disabled>
            <BookmarkIcon />
            {t('history.quickAccess')}
          </button>
          <button type="button" className="history-tab is-active">
            <ChatIcon />
            {t('history.chatHistory')}
          </button>
          <button type="button" className="history-tab is-muted" disabled>
            <GlobeIcon />
            {t('history.webHistory')}
          </button>
        </div>
        <button className="history-refresh" type="button" onClick={refresh} disabled={loading}>
          {loading ? t('history.loading') : t('history.refresh')}
        </button>
      </header>

      <main className="history-content">
        {error && <div className="history-error">{error}</div>}

        {loading && items.length === 0 ? (
          <div className="rt-loading">{t('history.loading')}</div>
        ) : items.length === 0 ? (
          <div className="rt-empty">
            <div className="rt-empty__text">{t('history.empty')}</div>
            <div className="rt-empty__hint">{t('history.emptyHint')}</div>
          </div>
        ) : (
          <section className="history-card" aria-label={t('history.listLabel')}>
            {groups.map((group) => (
              <div className="history-date-group" key={group.key}>
                <h2 className="history-date-title">{group.label}</h2>
                <div className="history-date-list">
                  {group.items.map((item) => (
                    <HistoryRow
                      key={item.conversation.id}
                      item={item}
                      onOpen={() => onOpenConversation(item.conversation.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function HistoryRow({
  item,
  onOpen,
}: {
  item: ConversationHistoryItem;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const { conversation, lastMessage } = item;

  return (
    <button type="button" className="history-row" onClick={onOpen}>
      <span className="history-row__time">{formatTime(conversation.updatedAt)}</span>
      <span className={`history-row__source history-row__source--${conversation.channelType ?? 'desktop'}`}>
        <ChatIcon />
      </span>
      <span className="history-row__body">
        <span className="history-row__title">{conversation.title || t('history.untitled')}</span>
        <span className="history-row__summary">{lastMessage?.content || t('history.noMessage')}</span>
      </span>
    </button>
  );
}

function groupByDate(items: ConversationHistoryItem[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();

  for (const item of items) {
    const date = new Date(item.conversation.updatedAt);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');

    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label: formatDateLabel(date),
      items: [item],
    });
  }

  return Array.from(groups.values());
}

function formatDateLabel(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M8 9h.01" />
      <path d="M12 9h.01" />
      <path d="M16 9h.01" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15 15 0 0 1 0 20" />
      <path d="M12 2a15 15 0 0 0 0 20" />
    </svg>
  );
}
