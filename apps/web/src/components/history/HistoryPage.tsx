import { useEffect, useRef, useState } from 'react';
import type { ConversationHistoryItem, Vault } from '@molio/contracts';
import { api } from '../../api/client';
import { useI18n } from '../../i18n';
import { useHistoryFilters } from '../../hooks/useHistoryFilters';
import { useActiveVaultId } from '../../stores/vaultStore';
import { OverflowMenu, type OverflowItem } from '../../components/OverflowMenu';

interface Props {
  onOpenConversation: (conversationId: string) => void;
}

export function HistoryPage({ onOpenConversation }: Props) {
  const { t } = useI18n();
  const currentVaultId = useActiveVaultId();
  const { filters, setFilter, setQuery, items, pinnedItems, loading, error, loadMore, refresh, hasMore, deleteConversationLocal, updateConversationLocal } = useHistoryFilters(currentVaultId);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const deleteErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.listVaults().then(setVaults).catch(() => { /* best-effort */ });
  }, []);

  // Clear any transient delete/action errors on unmount.
  useEffect(() => {
    return () => {
      if (deleteErrorTimer.current) clearTimeout(deleteErrorTimer.current);
      if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
    };
  }, []);

  const clearFilters = () => {
    setFilter('vaultFilter', '');
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

  const confirmRename = async (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return; // 空标题在弹窗内处理（保持弹窗打开）
    setRenameTarget(null); // 关闭弹窗
    updateConversationLocal(id, { title: trimmed });
    try {
      await api.updateConversation(id, { title: trimmed });
    } catch {
      refresh();
      setActionError(t('history.renameFailed'));
      if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
      actionErrorTimer.current = setTimeout(() => setActionError(null), 3000);
    }
  };

  const startRename = (item: ConversationHistoryItem) => {
    setRenameTarget({ id: item.conversation.id, title: item.conversation.title });
  };

  const togglePin = async (id: string, currentlyPinned: boolean) => {
    updateConversationLocal(id, { pinned: !currentlyPinned });
    try {
      await api.updateConversation(id, { pinned: !currentlyPinned });
    } catch {
      refresh();
      setActionError(t('history.pinFailed'));
      if (actionErrorTimer.current) clearTimeout(actionErrorTimer.current);
      actionErrorTimer.current = setTimeout(() => setActionError(null), 3000);
    }
  };

  const isFilterActive = Boolean(filters.vaultFilter || filters.query.trim());

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
              value={filters.vaultFilter}
              onChange={(e) => setFilter('vaultFilter', e.target.value)}
            >
            <option value="">{t('history.filter.all')}</option>
            {currentVaultId && (
              // 窗口自己的库就是默认作用域（本库 + 未关联渠道会话）：一个库名只有
              // 一个含义，不另设「当前知识库」伪选项。value 保持 '__current__'，
              // 其余库名严格过滤。库列表未加载完时名字回落到通用文案。
              <option value="__current__">
                {vaults.find((v) => v.id === currentVaultId)?.name ?? t('history.filter.currentVault')}
              </option>
            )}
            {vaults
              .filter((v) => v.id !== currentVaultId)
              .map((v) => (
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
        {actionError && (
          <div className="history-error" data-testid="history-action-error">{actionError}</div>
        )}
        {pinnedItems.length > 0 && (
          <PinnedGroup
            items={pinnedItems}
            collapsed={pinnedCollapsed}
            onToggleCollapse={() => setPinnedCollapsed((v) => !v)}
            onOpenConversation={onOpenConversation}
            confirmingDeleteId={confirmingDeleteId}
            onDeleteRequest={setConfirmingDeleteId}
            onDeleteCancel={() => setConfirmingDeleteId(null)}
            onDeleteConfirm={executeDelete}
            onStartRename={startRename}
            onTogglePin={togglePin}
            t={t}
          />
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
        ) : items.length === 0 && pinnedItems.length === 0 ? (
          filters.query.trim() ? (
            <div className="history-empty">
              <p className="history-empty__text">{t('history.noMatch')}</p>
              <button className="history-clear-filters" data-testid="history-clear-filters" type="button" onClick={clearFilters}>
                {t('history.clearFilters')}
              </button>
            </div>
          ) : filters.vaultFilter === '__current__' ? (
            <div className="history-empty" data-testid="history-empty-scoped">
              <p className="history-empty__text">{t('history.emptyScoped')}</p>
              <button className="history-clear-filters" data-testid="history-view-all" type="button" onClick={clearFilters}>
                {t('history.viewAll')}
              </button>
            </div>
          ) : isFilterActive ? (
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
            onStartRename={startRename}
            onTogglePin={togglePin}
            t={t}
          />
        )}

        {hasMore && (
          <button className="history-load-more" data-testid="history-load-more" type="button" onClick={loadMore} disabled={loading}>
            {loading ? t('history.loading') : t('history.loadMore')}
          </button>
        )}
      </main>

      <RenameDialog key={renameTarget?.id ?? 'closed'} target={renameTarget} onClose={() => setRenameTarget(null)} onConfirm={confirmRename} t={t} />
    </div>
  );
}

function HistoryList({ items, onOpenConversation, confirmingDeleteId, onDeleteRequest, onDeleteCancel, onDeleteConfirm, onStartRename, onTogglePin, t }: {
  items: ConversationHistoryItem[];
  onOpenConversation: (id: string) => void;
  confirmingDeleteId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: (id: string) => void;
  onStartRename: (item: ConversationHistoryItem) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
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
              <span className="history-date-chevron">
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
                    onStartRename={onStartRename}
                    onTogglePin={onTogglePin}
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

function HistoryRow({ item, onOpen, confirmingDeleteId, onDeleteRequest, onDeleteCancel, onDeleteConfirm, onStartRename, onTogglePin, t }: {
  item: ConversationHistoryItem;
  onOpen: () => void;
  confirmingDeleteId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: (id: string) => void;
  onStartRename: (item: ConversationHistoryItem) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
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

  const overflowItems: OverflowItem[] = [
    {
      icon: conversation.pinnedAt ? <PinIconFilled /> : <PinIcon />,
      label: conversation.pinnedAt ? t('history.unpin') : t('history.pin'),
      testid: 'history-row-pin',
      onClick: () => onTogglePin(conversation.id, Boolean(conversation.pinnedAt)),
    },
    {
      icon: <RenameIcon />,
      label: t('history.rename'),
      testid: 'history-row-rename',
      onClick: () => onStartRename(item),
    },
    {
      icon: <TrashIcon />,
      label: t('history.delete'),
      testid: 'history-row-delete',
      danger: true,
      onClick: () => onDeleteRequest(conversation.id),
    },
  ];

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
      <OverflowMenu
        triggerTestid="history-row-overflow"
        triggerLabel={t('history.more')}
        items={overflowItems}
      />
    </div>
  );
}

function RenameDialog({ target, onClose, onConfirm, t }: {
  target: { id: string; title: string | null } | null;
  onClose: () => void;
  onConfirm: (id: string, title: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [emptyError, setEmptyError] = useState(false);
  // Reset the error when the dialog opens for a new target.
  useEffect(() => {
    if (target) setEmptyError(false);
  }, [target]);
  if (!target) return null;
  return (
    <div className="kb-overlay show" data-testid="history-rename-dialog" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kb-modal" style={{ width: 420 }}>
        <div className="kb-modal-header">
          <h2>{t('history.renameDialogTitle')}</h2>
          <button className="kb-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="kb-modal-body">
          <div className="kb-form-field">
            <label htmlFor="history-rename-input">{t('history.titleLabel')}</label>
            <input
              id="history-rename-input"
              data-testid="history-rename-input"
              type="text"
              ref={inputRef}
              defaultValue={target.title ?? ''}
              placeholder={t('history.untitled')}
              autoFocus
              onChange={() => setEmptyError(false)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onClose(); }}
            />
            {emptyError && (
              <span className="history-rename-error" data-testid="history-rename-error">{t('history.renameEmpty')}</span>
            )}
          </div>
        </div>
        <div className="kb-modal-footer">
          <button className="kb-btn kb-btn-ghost" data-testid="history-rename-cancel" onClick={onClose}>{t('history.cancel')}</button>
          <button className="kb-btn kb-btn-primary" data-testid="history-rename-confirm" onClick={submit}>{t('history.confirm')}</button>
        </div>
      </div>
    </div>
  );
  function submit() {
    const v = (inputRef.current?.value ?? '').trim();
    if (!v) { setEmptyError(true); return; }
    if (!target) return;
    onConfirm(target.id, v);
  }
}

function PinnedGroup({ items, collapsed, onToggleCollapse, onOpenConversation, confirmingDeleteId, onDeleteRequest, onDeleteCancel, onDeleteConfirm, onStartRename, onTogglePin, t }: {
  items: ConversationHistoryItem[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenConversation: (id: string) => void;
  confirmingDeleteId: string | null;
  onDeleteRequest: (id: string) => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: (id: string) => void;
  onStartRename: (item: ConversationHistoryItem) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="history-pinned">
      <button
        type="button"
        className="history-pinned-title"
        data-testid="history-pinned-title"
        onClick={onToggleCollapse}
        aria-expanded={!collapsed}
      >
        <span className="history-pinned-chevron">
          <ChevronIcon expanded={!collapsed} />
        </span>
        <span className="history-pinned-glyph">
          <PinIconFilled />
        </span>
        {t('history.pinned')}
        <span className="history-pinned-count">{items.length}</span>
      </button>
      {!collapsed && (
        <div className="history-date-list">
          {items.map((item) => (
            <HistoryRow
              key={item.conversation.id}
              item={item}
              onOpen={() => onOpenConversation(item.conversation.id)}
              confirmingDeleteId={confirmingDeleteId}
              onDeleteRequest={onDeleteRequest}
              onDeleteCancel={onDeleteCancel}
              onDeleteConfirm={onDeleteConfirm}
              onStartRename={onStartRename}
              onTogglePin={onTogglePin}
              t={t}
            />
          ))}
        </div>
      )}
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
function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
      <path d="M12 17v5" />
    </svg>
  );
}
function PinIconFilled() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" fill="currentColor" />
      <path d="M12 17v5" />
    </svg>
  );
}
function RenameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  );
}
