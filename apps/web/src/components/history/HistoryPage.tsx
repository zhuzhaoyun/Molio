import { useEffect, useRef, useState } from 'react';
import type { ConversationHistoryItem, Vault, AgentInfo } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useHistoryFilters } from '../../hooks/useHistoryFilters';

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

const CHANNEL_OPTIONS = [
  { value: '', labelKey: 'history.filter.all' },
  { value: 'desktop', labelKey: 'history.source.desktop' },
  { value: 'weixin', labelKey: 'history.source.weixin' },
  { value: 'feishu', labelKey: 'history.source.feishu' },
  { value: 'wecom', labelKey: 'history.source.wecom' },
];

export function HistoryPage({ onOpenConversation }: Props) {
  const { t } = useI18n();
  const { filters, setFilter, setQuery, items, loading, error, loadMore, refresh, hasMore, deleteConversationLocal } = useHistoryFilters();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([api.listVaults(), api.listAgents()]).then(([v, a]) => {
      setVaults(v);
      setAgents(a);
    }).catch(() => { /* best-effort */ });
  }, []);

  // Clear any transient delete error on unmount.
  useEffect(() => {
    return () => {
      if (deleteErrorTimer.current) clearTimeout(deleteErrorTimer.current);
    };
  }, []);

  const clearFilters = () => {
    setFilter('vaultId', '');
    setFilter('channelType', '');
    setFilter('agentId', '');
    setQuery('');
  };

  const onDelete = async (id: string) => {
    deleteConversationLocal(id);
    try {
      await api.deleteConversationById(id);
    } catch {
      // rollback: re-fetch to restore (refresh kicks off an async fetch but
      // returns void; the E2E polls for the row to reappear).
      refresh();
      // Non-blocking transient error (spec §7.5): no alert(), which blocks the
      // main thread and makes E2E fragile. Reuse the .history-error styling.
      if (deleteErrorTimer.current) clearTimeout(deleteErrorTimer.current);
      setDeleteError(t('history.deleteFailed'));
      deleteErrorTimer.current = setTimeout(() => setDeleteError(null), 3000);
    }
  };

  const isFilterActive = Boolean(
    filters.vaultId || filters.channelType || filters.agentId || filters.query.trim(),
  );

  return (
    <div className="history-shell">
      <header className="history-topbar">
        <div className="history-title">
          <span className="history-title__icon"><ChatIcon /></span>
          <h1>{t('nav.history')}</h1>
        </div>
        <button className="history-refresh" type="button" onClick={refresh} disabled={loading} data-testid="history-refresh">
          {loading ? t('history.loading') : t('history.refresh')}
        </button>
      </header>

      <div className="history-filters">
        <label className="history-filter-field">
          <span className="history-filter-label">{t('history.filter.vault')}</span>
          <select
            className="history-filter-select"
            data-testid="history-filter-vault"
            value={filters.vaultId}
            onChange={(e) => setFilter('vaultId', e.target.value)}
          >
            <option value="">{t('history.filter.all')}</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
            <option value="__none__">{t('history.filter.unassociated')}</option>
          </select>
        </label>

        <label className="history-filter-field">
          <span className="history-filter-label">{t('history.filter.channel')}</span>
          <select
            className="history-filter-select"
            data-testid="history-filter-channel"
            value={filters.channelType}
            onChange={(e) => setFilter('channelType', e.target.value)}
          >
            {CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
        </label>

        <label className="history-filter-field">
          <span className="history-filter-label">{t('history.filter.agent')}</span>
          <select
            className="history-filter-select"
            data-testid="history-filter-agent"
            value={filters.agentId}
            onChange={(e) => setFilter('agentId', e.target.value)}
          >
            <option value="">{t('history.filter.all')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>

        <input
          className="history-search-input"
          data-testid="history-search-input"
          type="search"
          placeholder={t('history.search.placeholder')}
          value={filters.query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <main className="history-content">
        {error && <div className="history-error">{error}</div>}
        {deleteError && (
          <div className="history-error" data-testid="history-delete-error">{deleteError}</div>
        )}

        {loading && items.length === 0 ? (
          <div className="rt-loading">{t('history.loading')}</div>
        ) : items.length === 0 ? (
          isFilterActive ? (
            <div className="rt-empty">
              <div className="rt-empty__text">{t('history.noMatch')}</div>
              <button className="history-clear-filters" data-testid="history-clear-filters" type="button" onClick={clearFilters}>
                {t('history.clearFilters')}
              </button>
            </div>
          ) : (
            <div className="rt-empty" data-testid="history-empty">
              <div className="rt-empty__text">{t('history.empty')}</div>
              <div className="rt-empty__hint">{t('history.emptyHint')}</div>
            </div>
          )
        ) : (
          <HistoryList items={items} onOpenConversation={onOpenConversation} onDelete={onDelete} t={t} />
        )}

        {hasMore && (
          <button className="history-load-more" data-testid="history-load-more" type="button" onClick={loadMore} disabled={loading}>
            {loading ? t('history.loading') : t('history.loadMore')}
          </button>
        )}
      </main>
    </div>
  );
}

function HistoryList({ items, onOpenConversation, onDelete, t }: {
  items: ConversationHistoryItem[];
  onOpenConversation: (id: string) => void;
  onDelete: (id: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const groups = groupByDate(items);
  return (
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
                onDelete={() => onDelete(item.conversation.id)}
                t={t}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function HistoryRow({ item, onOpen, onDelete, t }: {
  item: ConversationHistoryItem;
  onOpen: () => void;
  onDelete: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { conversation, lastMessage, vaultName, vaultId } = item;
  const vaultLabel = vaultName ?? (vaultId ? t('history.vaultDeleted') : t('history.filter.unassociated'));
  return (
    <div className="history-row">
      <button type="button" className="history-row__main" onClick={onOpen}>
        <span className="history-row__time">{formatTime(conversation.updatedAt)}</span>
        <span className={`history-row__source history-row__source--${conversation.channelType ?? 'desktop'}`}>
          <ChatIcon />
        </span>
        <span className="history-row__body">
          <span className="history-row__title-line">
            <span className="history-row__title">{conversation.title || t('history.untitled')}</span>
            <span className={`history-source-badge history-source-badge--${conversation.channelType ?? 'desktop'}`}>
              {sourceLabel(t, conversation.channelType)}
            </span>
            <span className="history-vault-badge">{vaultLabel}</span>
          </span>
          <span className="history-row__summary">{lastMessage?.content || t('history.noMessage')}</span>
        </span>
      </button>
      <button type="button" className="history-row__delete" data-testid="history-row-delete" onClick={onDelete} title={t('history.delete')}>
        <TrashIcon />
      </button>
    </div>
  );
}

interface HistoryGroup { key: string; label: string; items: ConversationHistoryItem[]; }

function groupByDate(items: ConversationHistoryItem[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const item of items) {
    const date = new Date(item.conversation.updatedAt);
    const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    const existing = groups.get(key);
    if (existing) { existing.items.push(item); continue; }
    groups.set(key, { key, label: formatDateLabel(date), items: [item] });
  }
  return Array.from(groups.values());
}

function formatDateLabel(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function sourceLabel(t: (key: string, params?: Record<string, string | number>) => string, channelType?: string) {
  if (channelType === 'weixin') return t('history.source.weixin');
  if (channelType === 'feishu') return t('history.source.feishu');
  if (channelType === 'wecom') return t('history.source.wecom');
  return t('history.source.desktop');
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6" />
    </svg>
  );
}
