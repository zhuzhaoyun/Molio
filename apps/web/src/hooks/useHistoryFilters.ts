import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationHistoryItem, ListHistoryQuery } from '@molio/contracts';
import { api } from '../api/client';

export interface HistoryFilters {
  vaultId: string;      // '' = all
  query: string;        // '' = no search
}

const EMPTY_FILTERS: HistoryFilters = { vaultId: '', query: '' };
const STALE_MS = 30_000;
const PAGE_SIZE = 50;

export function useHistoryFilters() {
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  const reqToken = useRef(0);
  const lastFetchAt = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const buildOpts = useCallback((f: HistoryFilters, before?: number | null): ListHistoryQuery => {
    const opts: ListHistoryQuery = { limit: PAGE_SIZE };
    if (f.vaultId) opts.vaultId = f.vaultId;
    if (f.query.trim()) opts.query = f.query.trim();
    if (before != null) opts.before = before;
    return opts;
  }, []);

  const fetchFirst = useCallback(async (f: HistoryFilters) => {
    const token = ++reqToken.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.listConversationHistory(buildOpts(f));
      if (token !== reqToken.current) return; // stale
      setItems(page.items);
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
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      lastFetchAt.current = Date.now();
    } catch (err) {
      if (token !== reqToken.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (token === reqToken.current) setLoading(false);
    }
  }, [nextCursor, loading, buildOpts]);

  const setFilter = useCallback((key: 'vaultId', value: string) => {
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

  /** Optimistic delete: remove locally; caller rolls back on failure. */
  const deleteConversationLocal = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.conversation.id !== id));
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
    items,
    loading,
    error,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
    deleteConversationLocal,
  };
}
