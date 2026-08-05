import { useState, useEffect, useCallback, useRef } from 'react';
import type { VaultSkillEntry } from '@molio/contracts';
import { api } from '../api/client';

/**
 * Per-vault skill enablement state. Loads the skill list (with each skill's
 * effective state in the given vault) on mount / vault change, and exposes an
 * optimistic toggle that reconciles with the server — mirroring useSkills.
 *
 * `vaultId === null` means "no vault selected": nothing is fetched and the list
 * stays empty, so the modal can render safely before a vault exists.
 *
 * Race guards (same rationale as useSkills): per-skill sequence numbers make
 * only the latest toggle authoritative, and a vaultId ref drops responses that
 * arrive after the user already switched to another vault.
 */
export function useVaultSkills(vaultId: string | null) {
  const [skills, setSkills] = useState<VaultSkillEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSeqRef = useRef(0);
  const desiredRef = useRef<Map<string, boolean>>(new Map());
  const toggleSeqRef = useRef<Map<string, number>>(new Map());
  const vaultIdRef = useRef(vaultId);
  useEffect(() => { vaultIdRef.current = vaultId; }, [vaultId]);

  /** Overlay in-flight toggle intents on top of freshly fetched server data. */
  const applyDesired = useCallback((list: VaultSkillEntry[]) => {
    const desired = desiredRef.current;
    if (desired.size === 0) return list;
    return list.map((s) => (desired.has(s.id) ? { ...s, vaultEnabled: desired.get(s.id)! } : s));
  }, []);

  const refresh = useCallback(async () => {
    if (!vaultId) {
      setSkills([]);
      return;
    }
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listVaultSkills(vaultId);
      // Drop responses for a vault the user already left.
      if (refreshSeqRef.current === seq && vaultIdRef.current === vaultId) {
        setSkills(applyDesired(data));
      }
    } catch (err) {
      if (refreshSeqRef.current === seq && vaultIdRef.current === vaultId) {
        setError((err as Error).message);
      }
    } finally {
      if (refreshSeqRef.current === seq && vaultIdRef.current === vaultId) {
        setLoading(false);
      }
    }
  }, [vaultId, applyDesired]);

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
    const vaultAtCall = vaultId;
    if (!vaultAtCall) return;
    // Optimistic flip for instant feedback; the daemon owns the .claude/skills
    // sync, so the server response is what ultimately counts.
    const seqs = toggleSeqRef.current;
    const seq = (seqs.get(skillId) ?? 0) + 1;
    seqs.set(skillId, seq);
    desiredRef.current.set(skillId, enabled);
    setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, vaultEnabled: enabled } : s)));
    try {
      const skill = await api.setVaultSkillEnabled(vaultAtCall, skillId, enabled);
      // Only the latest toggle for this skill in THIS vault may write state.
      if (seqs.get(skillId) === seq && vaultIdRef.current === vaultAtCall) {
        desiredRef.current.delete(skillId);
        upsert(skill);
      }
    } catch (err) {
      if (seqs.get(skillId) === seq && vaultIdRef.current === vaultAtCall) {
        desiredRef.current.delete(skillId);
        // Latest intent failed: re-sync from the server instead of a blind
        // flip-back guess.
        void refresh();
      }
      throw err;
    }
  }, [vaultId, upsert, refresh]);

  return { skills, loading, error, refresh, toggle };
}
