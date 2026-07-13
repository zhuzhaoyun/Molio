import { useEffect, useRef, useState } from 'react';
import type { ConversationHistoryItem, Vault } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useHistoryFilters } from '../../hooks/useHistoryFilters';

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

export function HistoryPage({ onOpenConversation }: Props) {
  const { t } = useI18n();
  const { filters, setFilter, setQuery, items, loading, error, loadMore, refresh, hasMore, deleteConversationLocal } = useHistoryFilters();
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const deleteErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.listVaults().then(setVaults).catch(() => { /* best-effort */ });
  }, []);

  // Clear any transient delete error on unmount.
  useEffect(() => {
    return () => {
      if (deleteErrorTimer.current) clearTimeout(deleteErrorTimer.current);
    };
  }, []);

  const clearFilters = () => {
    setFilter('vaultId', '');
    setQuery('');
  };

  const executeDelete = async (id: string) => {
    setConfirmingDeleteId(null);
    deleteConversationLocal(id);
    try {
      await api.deleteConversationById(id);
    } catch {
      refresh();
      if (deleteErrorTimer.current) clearTimeout(deleteErrorTimer.current);
      setDeleteError(t('history.deleteFailed'));
      deleteErrorTimer.current = setTimeout(() => setDeleteError(null), 3000);
    }
  };

  const isFilterActive = Boolean(filters.vaultId || filters.query.trim());

  return (
    <div className="history-shell">
      <header className="history-topbar">
        <div className="history-title">
          <span className="history-title__icon"><ChatIcon /></span>
          <h1>{t('nav.history')}</h1>
        </div>
      </header>

      <div className="history-filters">
        <div className="history-search-row">
          <div className="history-search-wrap">
            <SearchIcon />
            <input
              className="history-search-input"
              data-testid="history-search-input"
              type="search"
              placeholder={t('history.search.placeholder')}
              value={filters.query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
          <label className="history-filter-label--inline">
            <span className="history-filter-label__text">{t('history.filter.vault')}</span>
            <select
              className="history-filter-select history-filter-select--vault"
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
          <button
            className={`history-refresh${loading ? ' history-refresh--loading' : ''}`}
            type="button"
            onClick={refresh}
            disabled={loading}
            data-testid="history-refresh"
            aria-label={t('history.refresh')}
            title={t('history.refresh')}
          >
            {loading ? <LoadingIcon /> : <RefreshIcon />}
          </button>
        </div>
      </div>

      <main className="history-content">
        {error && <div className="history-error">{error}</div>}
        {deleteError && (
          <div className="history-error" data-testid="history-delete-error">{deleteError}</div>
        )}

        {loading && items.length === 0 ? (
          <div className="history-skeleton" aria-busy="true" aria-label={t('history.loading')}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div className="history-skeleton__row" key={i}>
                <span className="history-skeleton__time" />
                <span className="history-skeleton__body">
                  <span className="history-skeleton__title" />
                  <span className="history-skeleton__summary" />
                </span>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          isFilterActive ? (
            <div className="history-empty">
              <p className="history-empty__text">{t('history.noMatch')}</p>
              <button className="history-clear-filters" data-testid="history-clear-filters" type="button" onClick={clearFilters}>
                {t('history.clearFilters')}
              </button>
            </div>
          ) : (
            <div className="history-empty" data-testid="history-empty">
              <p className="history-empty__text">{t('history.empty')}</p>
              <p className="history-empty__hint">{t('history.emptyHint')}</p>
            </div>
          )
        ) : (
          <HistoryList
            items={items}
            onOpenConversation={onOpenConversation}
            confirmingDeleteId={confirmingDeleteId}
            onDeleteRequest={setConfirmingDeleteId}
            onDeleteCancel={() => setConfirmingDeleteId(null)}
            onDeleteConfirm={executeDelete}
            t={t}
          />
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

function HistoryList({ items, onOpenConversation, confirmingDeleteId, onDeleteRequest, onDeleteCancel, onDeleteConfirm, t }: {
  items: ConversationHistoryItem[];
  onOpenConversation: (id: string) => void;
  confirmingDeleteId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: (id: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const groups = groupByDate(items);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div aria-label={t('history.listLabel')}>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <div className={`history-date-group${isCollapsed ? ' history-date-group--collapsed' : ''}`} key={group.key}>
            <button
              type="button"
              className="history-date-title"
              onClick={() => toggleGroup(group.key)}
              aria-expanded={!isCollapsed}
            >
              <span className={`history-date-chevron${isCollapsed ? '' : ' history-date-chevron--open'}`}>
                <ChevronIcon expanded={!isCollapsed} />
              </span>
              {group.label}
              <span className="history-date-count">{group.items.length}</span>
            </button>
            {!isCollapsed && (
              <div className="history-date-list">
                {group.items.map((item) => (
                  <HistoryRow
                    key={item.conversation.id}
                    item={item}
                    onOpen={() => onOpenConversation(item.conversation.id)}
                    confirmingDeleteId={confirmingDeleteId}
                    onDeleteRequest={onDeleteRequest}
                    onDeleteCancel={onDeleteCancel}
                    onDeleteConfirm={onDeleteConfirm}
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HistoryRow({ item, onOpen, confirmingDeleteId, onDeleteRequest, onDeleteCancel, onDeleteConfirm, t }: {
  item: ConversationHistoryItem;
  onOpen: () => void;
  confirmingDeleteId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: (id: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { conversation, lastMessage, vaultName, vaultExists, vaultId } = item;
  const isConfirming = confirmingDeleteId === conversation.id;

  // Vault indicator:
  // 1. Alive vault          → name badge (gray)
  // 2. Deleted vault        → name badge (red)
  // No vault (vaultId null) → nothing.
  const vaultLabel = vaultName || undefined;
  const vaultDeleted = vaultId != null && !vaultExists;
  const vaultBadgeCls = vaultLabel
    ? `history-vault-badge${vaultDeleted ? ' history-vault-badge--deleted' : ''}`
    : undefined;

  // Channel badge — only for non-desktop channels (desktop is the silent default).
  const channelType = conversation.channelType;
  const showChannelBadge = Boolean(channelType && channelType !== 'desktop');

  if (isConfirming) {
    return (
      <div className="history-row history-row--confirming">
        <span className="history-row__confirm-text">{t('history.deleteConfirm')}</span>
        <button
          type="button"
          className="history-row__confirm-yes"
          data-testid="history-row-delete-confirm"
          onClick={() => onDeleteConfirm(conversation.id)}
        >
          {t('history.deleteConfirmYes')}
        </button>
        <button
          type="button"
          className="history-row__confirm-no"
          data-testid="history-row-delete-cancel"
          onClick={onDeleteCancel}
        >
          {t('history.deleteConfirmNo')}
        </button>
      </div>
    );
  }

  return (
    <div className="history-row">
      <button type="button" className="history-row__main" onClick={onOpen}>
        <span className="history-row__time">{formatTime(conversation.updatedAt)}</span>
        <span className="history-row__body">
          <span className="history-row__title-line">
            <span className="history-row__title">{conversation.title || t('history.untitled')}</span>
            {vaultBadgeCls && (
              <span className={vaultBadgeCls} title={vaultDeleted ? t('history.vaultDeleted') : vaultLabel}>
                {vaultLabel}
              </span>
            )}
            {showChannelBadge && (
              <span className={`history-source-badge history-source-badge--${channelType}`}>
                {sourceLabel(t, channelType!)}
              </span>
            )}
          </span>
          <span className="history-row__summary">{lastMessage?.content || t('history.noMessage')}</span>
        </span>
      </button>
      <button type="button" className="history-row__delete" data-testid="history-row-delete" onClick={() => onDeleteRequest(conversation.id)} title={t('history.delete')}>
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
function LoadingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="m4.9 4.9 2.8 2.8" />
      <path d="m16.3 16.3 2.8 2.8" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="m4.9 19.1 2.8-2.8" />
      <path d="m16.3 7.7 2.8-2.8" />
    </svg>
  );
}
