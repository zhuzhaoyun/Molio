import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  SkillManifestEntry,
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillRequest,
} from '@molio/contracts';
import { api } from '../api/client';

/**
 * Global skill library state. Mirrors useRuntimes: loads on mount, exposes
 * CRUD actions that update the daemon and then reconcile local state from the
 * authoritative response (no blind optimistic writes — the daemon owns the
 * per-vault sync into each `<vault>/.claude/skills/`, so we trust the entry it
 * returns).
 *
 * Toggle races are guarded explicitly: a slow first request must not be able
 * to overwrite the state of a newer toggle (double-click, flaky network).
 *  - toggleSeqRef: per-id sequence numbers — only the LATEST toggle's response
 *    may write state; stale responses are dropped.
 *  - desiredRef: the in-flight desired value per skill, so a concurrent list
 *    refresh can't clobber the optimistic flip with the (stale) server value.
 *  - refreshSeqRef: a slow list response never overwrites a newer one.
 */
export function useSkills() {
  const [skills, setSkills] = useState<SkillManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshSeqRef = useRef(0);
  const desiredRef = useRef<Map<string, boolean>>(new Map());
  const toggleSeqRef = useRef<Map<string, number>>(new Map());

  /** Overlay in-flight toggle intents on top of freshly fetched server data. */
  const applyDesired = useCallback((list: SkillManifestEntry[]) => {
    const desired = desiredRef.current;
    if (desired.size === 0) return list;
    return list.map((s) => (desired.has(s.id) ? { ...s, enabled: desired.get(s.id)! } : s));
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listSkills();
      if (refreshSeqRef.current === seq) setSkills(applyDesired(data));
    } catch (err) {
      if (refreshSeqRef.current === seq) setError((err as Error).message);
    } finally {
      if (refreshSeqRef.current === seq) setLoading(false);
    }
  }, [applyDesired]);

  useEffect(() => { refresh(); }, [refresh]);

  /** Replace one entry in the local list (or append if new). */
  const upsert = useCallback((entry: SkillManifestEntry) => {
    setSkills((prev) => {
      const idx = prev.findIndex((s) => s.id === entry.id);
      if (idx === -1) return [...prev, entry];
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  const createSkill = useCallback(async (req: CreateSkillRequest): Promise<SkillManifestEntry> => {
    const skill = await api.createSkill(req);
    upsert(skill);
    return skill;
  }, [upsert]);

  const updateSkill = useCallback(async (id: string, req: UpdateSkillRequest): Promise<SkillManifestEntry> => {
    const skill = await api.updateSkill(id, req);
    upsert(skill);
    return skill;
  }, [upsert]);

  const toggleSkill = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    // Optimistic flip for instant toggle feedback.
    const seqs = toggleSeqRef.current;
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    desiredRef.current.set(id, enabled);
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      const skill = await api.toggleSkill(id, enabled);
      // Only the latest toggle for this id is authoritative — a stale response
      // (an earlier toggle that resolved late) must not undo the newer state.
      if (seqs.get(id) === seq) {
        desiredRef.current.delete(id);
        upsert(skill);
      }
    } catch (err) {
      if (seqs.get(id) === seq) {
        desiredRef.current.delete(id);
        // Latest intent failed: re-sync from the server — it is the only
        // authority on the actual state, so no blind flip-back guess.
        void refresh();
      }
      throw err;
    }
  }, [upsert, refresh]);

  const deleteSkill = useCallback(async (id: string): Promise<void> => {
    await api.deleteSkill(id);
    setSkills((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const importSkill = useCallback(async (req: ImportSkillRequest): Promise<SkillManifestEntry> => {
    const skill = await api.importSkill(req);
    upsert(skill);
    return skill;
  }, [upsert]);

  return {
    skills,
    loading,
    error,
    refresh,
    createSkill,
    updateSkill,
    toggleSkill,
    deleteSkill,
    importSkill,
  };
}
