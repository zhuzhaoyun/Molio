import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationHistoryItem } from '@molio/contracts';
import { api } from '../api/client';
import {
  buildListQuery,
  initialVaultFilter,
  type HistoryListQuery,
  type VaultFilterValue,
} from './historyFilterQuery';

export interface HistoryFilters {
  vaultFilter: VaultFilterValue;  // '' = all, '__current__' = this vault + unassociated
  query: string;                  // '' = no search
}

const STALE_MS = 30_000;
const PAGE_SIZE = 50;

export function useHistoryFilters(currentVaultId?: string | null) {
  const [filters, setFilters] = useState<HistoryFilters>(() => ({
    vaultFilter: initialVaultFilter(currentVaultId ?? null),
    query: '',
  }));
  const [pinnedItems, setPinnedItems] = useState<ConversationHistoryItem[]>([]);
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  const reqToken = useRef(0);
  const lastFetchAt = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const currentVaultRef = useRef(currentVaultId ?? null);
  currentVaultRef.current = currentVaultId ?? null;

  const buildOpts = useCallback((f: HistoryFilters, before?: number | null): HistoryListQuery => {
    const opts = buildListQuery(f, currentVaultRef.current, before);
    opts.limit = PAGE_SIZE;
    return opts;
  }, []);

  const fetchFirst = useCallback(async (f: HistoryFilters) => {
    const token = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listConversationHistory(buildOpts(f));
      if (token !== reqToken.current) return; // stale
      const nextPinned = page.pinnedItems ?? [];
      setPinnedItems(nextPinned);
      setItems(page.items);
      syncRef(nextPinned, page.items);
      setNextCursor(page.nextCursor);
      lastFetchAt.current = Date.now();
    } catch (err) {
      if (token !== reqToken.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [buildOpts]);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || loading) return;
    const token = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listConversationHistory(buildOpts(filtersRef.current, nextCursor));
      if (token !== reqToken.current) return;
      // 按 id 去重，防分页途中置顶状态变化导致同一会话重复出现。
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.conversation.id));
        const fresh = page.items.filter((i) => !seen.has(i.conversation.id));
        const next = [...prev, ...fresh];
        syncRef(stateRef.current.pinned, next);
        return next;
      });
      setNextCursor(page.nextCursor);
      lastFetchAt.current = Date.now();
    } catch (err) {
      if (token !== reqToken.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [nextCursor, loading, buildOpts]);

  const setFilter = useCallback((key: 'vaultFilter', value: VaultFilterValue) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      void fetchFirst(next);
      return next;
    });
  }, [fetchFirst]);

  const setQuery = useCallback((q: string) => {
    setFilters((prev) => ({ ...prev, query: q }));
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void fetchFirst(filtersRef.current);
    }, 300);
  }, [fetchFirst]);

  const refresh = useCallback(() => {
    void fetchFirst(filtersRef.current);
  }, [fetchFirst]);

  /** Optimistic delete: remove locally from both lists; caller rolls back on failure. */
  const deleteConversationLocal = useCallback((id: string) => {
    const nextPinned = stateRef.current.pinned.filter((i) => i.conversation.id !== id);
    const nextItems = stateRef.current.items.filter((i) => i.conversation.id !== id);
    setPinnedItems(nextPinned);
    setItems(nextItems);
    syncRef(nextPinned, nextItems);
  }, []);

  // 乐观更新依赖 stateRef 快照（原子搬移），而不是嵌套 setState updater——
  // 两个独立的 setState 闭包各自看到过期 state，会互相覆盖对方的搬移结果。
  const stateRef = useRef<{ pinned: ConversationHistoryItem[]; items: ConversationHistoryItem[] }>({ pinned: [], items: [] });
  const syncRef = (pinned: ConversationHistoryItem[], items: ConversationHistoryItem[]) => {
    stateRef.current = { pinned, items };
  };
  const mergeSorted = (arr: ConversationHistoryItem[], item: ConversationHistoryItem): ConversationHistoryItem[] => {
    const rest = arr.filter((i) => i.conversation.id !== item.conversation.id);
    const idx = rest.findIndex((i) => i.conversation.updatedAt < item.conversation.updatedAt);
    if (idx === -1) return [...rest, item];
    return [...rest.slice(0, idx), item, ...rest.slice(idx)];
  };

  /** Optimistic rename / pin / unpin. Caller refreshes on failure. */
  const updateConversationLocal = useCallback((id: string, patch: { title?: string; pinned?: boolean }) => {
    const { pinned, items } = stateRef.current;
    const src = pinned.find((i) => i.conversation.id === id) ?? items.find((i) => i.conversation.id === id) ?? null;
    if (!src) return;
    const wasPinned = pinned.some((i) => i.conversation.id === id);
    const isPinned = patch.pinned ?? wasPinned;
    const mutated: ConversationHistoryItem = {
      ...src,
      conversation: {
        ...src.conversation,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.pinned === true ? { pinnedAt: Date.now() } : {}),
        ...(patch.pinned === false ? { pinnedAt: null } : {}),
      },
    };
    let nextPinned = pinned.filter((i) => i.conversation.id !== id);
    let nextItems = items.filter((i) => i.conversation.id !== id);
    if (isPinned) nextPinned = mergeSorted(nextPinned, mutated);
    else nextItems = mergeSorted(nextItems, mutated);
    syncRef(nextPinned, nextItems);
    setPinnedItems(nextPinned);
    setItems(nextItems);
  }, []);

  // Initial + stale-refetch on mount.
  useEffect(() => {
    if (lastFetchAt.current && Date.now() - lastFetchAt.current < STALE_MS) return;
    void fetchFirst(filtersRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    filters,
    setFilter,
    setQuery,
    pinnedItems,
    items,
    loading,
    error,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
    deleteConversationLocal,
    updateConversationLocal,
  };
}
