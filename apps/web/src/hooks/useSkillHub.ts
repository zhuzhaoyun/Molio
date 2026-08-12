import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubCategory, HubSkillSummary, InstallHubSkillResponse } from '@molio/contracts';
import { api } from '../api/client';

/**
 * Skill store state: paged catalog from the daemon's hub proxy, debounced
 * keyword search + category filter, and install actions. Mirrors useSkills'
 * race-guard pattern — whichever list response arrives LAST for the CURRENT
 * query wins; stale responses (an old page/keyword) are dropped instead of
 * clobbering fresh results.
 */
export const HUB_PAGE_SIZE = 20;

export function useSkillHub() {
  const [skills, setSkills] = useState<HubSkillSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<HubCategory[]>([]);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  const pageRef = useRef(1);
  const seqRef = useRef(0);
  // Ref mirror of installingSlug for a same-tick re-entrancy guard (a rapid
  // double-click can fire the handler twice before the disabled attribute
  // commits). Reads are stable without adding deps to install().
  const installingRef = useRef<string | null>(null);

  const load = useCallback(
    async (page: number, reset: boolean) => {
      const seq = ++seqRef.current;
      if (reset) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const data = await api.listHubSkills({ page, pageSize: HUB_PAGE_SIZE, keyword, category });
        if (seqRef.current !== seq) return; // superseded by a newer query
        pageRef.current = data.page;
        setTotal(data.total);
        setSkills((prev) => (reset ? data.skills : [...prev, ...data.skills]));
        setHasMore(data.page * HUB_PAGE_SIZE < data.total && data.skills.length > 0);
      } catch (err) {
        if (seqRef.current === seq) setError((err as Error).message);
      } finally {
        if (seqRef.current === seq) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [keyword, category],
  );

  // Initial load + debounced re-query on keyword/category changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(1, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [load]);

  // Categories are a static-ish filter list: load once, tolerate failure
  // (the store still works without the filter).
  useEffect(() => {
    let cancelled = false;
    api
      .hubCategories()
      .then((data) => {
        if (!cancelled) setCategories(data.categories);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    void load(1, true);
  }, [load]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    void load(pageRef.current + 1, false);
  }, [load, loading, loadingMore, hasMore]);

  /**
   * Install (or refresh) one hub skill. Resolves with the daemon's response;
   * throws on failure so the caller can surface the message. Local installed
   * state is updated immediately on success.
   *
   * One install at a time: resolves null (no-op) when another install is
   * already in flight — the UI disables every install button meanwhile, this
   * is only the same-tick race backstop.
   */
  const install = useCallback(async (skill: HubSkillSummary): Promise<InstallHubSkillResponse | null> => {
    if (installingRef.current) return null;
    installingRef.current = skill.slug;
    setInstallingSlug(skill.slug);
    try {
      const res = await api.installHubSkill({
        slug: skill.slug,
        version: skill.version || undefined,
        namespace: skill.namespace,
      });
      // Invalidate any in-flight list query: its `installed` annotations were
      // computed before this install landed, so letting it resolve would
      // clobber the local patch below (skill flips back to "not installed").
      seqRef.current += 1;
      // The superseded query's seq-guarded finally won't reset its loading
      // flags — do it here, otherwise a loadMore in flight during an install
      // leaves loadingMore=true forever and pagination is permanently stuck.
      setLoading(false);
      setLoadingMore(false);
      setSkills((prev) =>
        prev.map((s) =>
          // Match the full identity: same slug in a different namespace is a
          // different skill and must keep its own installed state.
          s.slug === skill.slug && (s.namespace ?? '') === (skill.namespace ?? '')
            ? { ...s, installed: true, installedVersion: res.version }
            : s,
        ),
      );
      return res;
    } finally {
      installingRef.current = null;
      setInstallingSlug(null);
    }
  }, []);

  return {
    skills,
    total,
    loading,
    loadingMore,
    error,
    categories,
    keyword,
    setKeyword,
    category,
    setCategory,
    hasMore,
    installingSlug,
    refresh,
    loadMore,
    install,
  };
}
