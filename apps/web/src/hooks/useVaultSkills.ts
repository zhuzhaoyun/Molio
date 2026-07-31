import { useState, useEffect, useCallback } from 'react';
import type { VaultSkillEntry } from '@molio/contracts';
import { api } from '../api/client';

/**
 * Per-vault skill enablement state. Loads the skill list (with each skill's
 * effective state in the given vault) on mount / vault change, and exposes an
 * optimistic toggle that rolls back on failure — mirroring useSkills.
 *
 * `vaultId === null` means "no vault selected": nothing is fetched and the list
 * stays empty, so the modal can render safely before a vault exists.
 */
export function useVaultSkills(vaultId: string | null) {
  const [skills, setSkills] = useState<VaultSkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!vaultId) {
      setSkills([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.listVaultSkills(vaultId);
      setSkills(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => { refresh(); }, [refresh]);

  /** Replace one entry in the local list (or append if new). */
  const upsert = useCallback((entry: VaultSkillEntry) => {
    setSkills((prev) => {
      const idx = prev.findIndex((s) => s.id === entry.id);
      if (idx === -1) return [...prev, entry];
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  const toggle = useCallback(async (skillId: string, enabled: boolean): Promise<void> => {
    if (!vaultId) return;
    // Optimistic flip for instant feedback; reconcile with the server response
    // (the daemon owns the .claude/skills sync) and roll back on failure.
    setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, vaultEnabled: enabled } : s)));
    try {
      const skill = await api.setVaultSkillEnabled(vaultId, skillId, enabled);
      upsert(skill);
    } catch (err) {
      setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, vaultEnabled: !enabled } : s)));
      throw err;
    }
  }, [vaultId, upsert]);

  return { skills, loading, error, refresh, toggle };
}
