/**
 * 历史会话下拉菜单 — 共享给主页输入框（底部上弹）与 KB 会话标签栏（顶栏下弹）。
 *
 * 抽取自 ChatComposer 原有实现，主页渲染保持逐字不变（默认 align='up'）。
 * 按钮与下拉内部类名沿用 `.composer-history-*`，样式复用不另起一套。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { ConversationHistoryItem } from '@molio/contracts';
import { api } from '../api/client';

interface Props {
  /** 用户选中的会话 id */
  onSelect: (conversationId: string) => void;
  /** 按钮样式类（默认复用 composer-upload-btn） */
  buttonClassName?: string;
  /** 按钮 data-testid */
  buttonTestId?: string;
  /** 下拉展开方向：'up' = 输入框（底部上弹，默认）；'down' = 顶栏（向下展开） */
  align?: 'up' | 'down';
}

export function ConversationHistoryMenu({
  onSelect,
  buttonClassName,
  buttonTestId,
  align = 'up',
}: Props) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [show]);

  // 卸载时清理搜索防抖定时器
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const load = useCallback(async (query: string) => {
    try {
      // query 为空时传 undefined，等价原来的全量列表
      const { items: list, pinnedItems } = await api.listConversationHistory(query ? { query } : undefined);
      setItems([...pinnedItems, ...list]);
    } catch {
      // silently fail
    }
  }, []);

  const toggle = useCallback(async () => {
    if (show) {
      setShow(false);
      return;
    }
    setSearch('');
    setRenamingId(null);
    setConfirmDeleteId(null);
    setShow(true);
    await load('');
  }, [show, load]);

  // 输入搜索词 → 300ms 防抖后按 query 拉取（daemon FTS 全文搜索）
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void load(value); }, 300);
  }, [load]);

  const select = useCallback((conversationId: string) => {
    setShow(false);
    setConfirmDeleteId(null);
    onSelect(conversationId);
  }, [onSelect]);

  // ── hover 操作：重命名 ──
  const startRename = useCallback((item: ConversationHistoryItem) => {
    setConfirmDeleteId(null);
    setRenamingId(item.conversation.id);
    setRenameValue(item.conversation.title ?? '');
  }, []);

  const commitRename = useCallback(async () => {
    const id = renamingId;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!id || !title) return;
    try {
      await api.updateConversation(id, { title });
      setItems((prev) => prev.map((it) =>
        it.conversation.id === id ? { ...it, conversation: { ...it.conversation, title } } : it,
      ));
    } catch { /* 静默 */ }
  }, [renamingId, renameValue]);

  const cancelRename = useCallback(() => setRenamingId(null), []);

  // ── hover 操作：删除（两步确认，避免误删） ──
  const handleDeleteClick = useCallback((id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    void api.deleteConversationById(id)
      .then(() => setItems((prev) => prev.filter((it) => it.conversation.id !== id)))
      .catch(() => { /* 静默 */ });
  }, [confirmDeleteId]);

  return (
    // 默认（输入框）不设定位，下拉沿用原 containing block；顶栏变体加定位容器 + 向下展开
    <div className={align === 'down' ? 'conversation-history-menu' : undefined} ref={ref}>
      <button
        type="button"
        className={buttonClassName ?? 'composer-upload-btn'}
        data-testid={buttonTestId ?? 'composer-history-btn'}
        onClick={toggle}
        title={t('composer.history')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>
      {show && (
        <div
          className={`composer-history-dropdown${align === 'down' ? ' open-down' : ''}`}
          data-testid="composer-history-dropdown"
        >
          <div className="composer-history-header">
            <span>{t('composer.history')}</span>
          </div>
          <div className="composer-history-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              data-testid="composer-history-search"
              placeholder={t('composer.historySearchPlaceholder')}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              autoFocus
            />
          </div>
          <div className="composer-history-list">
            {items.length === 0 ? (
              <div className="composer-history-empty">
                {search ? t('composer.noSearchResults') : t('composer.noHistory')}
              </div>
            ) : (
              groupedHistory(items).map((group) => (
                <div key={group.label}>
                  <div className="composer-history-group">{group.label}</div>
                  {group.items.map((item) => {
                    const id = item.conversation.id;
                    const isRenaming = renamingId === id;
                    const channelType = item.conversation.channelType;
                    return (
                      <div
                        key={id}
                        className={`composer-history-item${isRenaming ? ' is-renaming' : ''}`}
                        data-testid="composer-history-item"
                      >
                        {isRenaming ? (
                          <input
                            className="composer-history-rename-input"
                            data-testid="composer-history-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRename();
                              if (e.key === 'Escape') cancelRename();
                            }}
                            onBlur={() => void commitRename()}
                            autoFocus
                          />
                        ) : (
                          <>
                            <button
                              type="button"
                              className="composer-history-item-main"
                              data-testid="composer-history-item-main"
                              onClick={() => select(id)}
                            >
                              <span className="composer-history-title">
                                {item.conversation.title || t('composer.untitled')}
                              </span>
                              {channelType && channelType !== 'desktop' && (
                                <span className="composer-history-channel">
                                  {channelType === 'weixin' ? '微信' : channelType}
                                </span>
                              )}
                              <span className="composer-history-time">
                                {formatHistoryTime(item.conversation.updatedAt)}
                              </span>
                            </button>
                            <div className="composer-history-actions">
                              <button
                                type="button"
                                className="composer-history-action"
                                data-testid="composer-history-rename"
                                aria-label="重命名"
                                title="重命名"
                                onClick={() => startRename(item)}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                className={`composer-history-action danger${confirmDeleteId === id ? ' is-confirming' : ''}`}
                                data-testid="composer-history-delete"
                                aria-label={confirmDeleteId === id ? '确认删除' : '删除'}
                                title={confirmDeleteId === id ? '再次点击确认删除' : '删除'}
                                onClick={() => handleDeleteClick(id)}
                              >
                                {confirmDeleteId === id ? '确认?' : (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface HistoryGroup {
  label: string;
  items: ConversationHistoryItem[];
}

function groupedHistory(items: ConversationHistoryItem[]): HistoryGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;

  const groups: Record<string, ConversationHistoryItem[]> = {};

  for (const item of items) {
    const ts = item.conversation.updatedAt;
    let key: string;
    if (ts >= todayStart) {
      key = '今天';
    } else if (ts >= yesterdayStart) {
      key = '昨天';
    } else if (ts >= weekStart) {
      key = '本周';
    } else {
      key = '更早';
    }
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const order = ['今天', '昨天', '本周', '更早'];
  return order.filter((k) => groups[k]).map((label) => ({ label, items: groups[label] }));
}

function formatHistoryTime(ts: number): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const thisYearStart = new Date(now.getFullYear(), 0, 1).getTime();
  if (ts >= thisYearStart) {
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
