import { useState, useEffect, useCallback } from 'react';
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
 */
export function useSkills() {
  const [skills, setSkills] = useState<SkillManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listSkills();
      setSkills(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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
    // Optimistic flip for instant toggle feedback; reconcile with the server
    // response and roll back on failure.
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      const skill = await api.toggleSkill(id, enabled);
      upsert(skill);
    } catch (err) {
      setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !enabled } : s)));
      throw err;
    }
  }, [upsert]);

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
