/**
 * Resolve the working directory for channel runs (weixin / feishu) from the
 * vault the user currently has selected in the UI.
 *
 * The web layer syncs every vault switch to the daemon (vaultStore →
 * POST /api/knowledge/active-vault → the `active_vault` KV), so the daemon DB
 * is the freshest source of "which vault is the user working in". Channels
 * previously read only `config.json`'s `defaultCwd`, which is written by a
 * web-side effect and can regress to a stale vault on desktop restart (the
 * App.tsx sync effect re-writes it from whatever vault the UI restored).
 * 2026-10 user report: 微信端入库永远进最初的库.
 *
 * Callers use this as the FIRST choice, falling back to `defaultCwd` — a
 * missing/unusable active vault must never break channel runs.
 */

import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { getActiveVaultId, getVault } from '../db.js';

/**
 * Path of the UI-selected active vault, or undefined when:
 *   - no db handle is available (channel constructed without one);
 *   - no active vault has ever been synced;
 *   - the pointer is stale (vault row deleted out of band);
 *   - the vault directory no longer exists on disk (unmounted NAS share,
 *     deleted folder) — spawning an agent with a non-existent cwd fails
 *     confusingly, so prefer the configured fallback instead.
 *
 * Never throws: channel message handling must not crash on a db hiccup.
 */
export function getActiveVaultCwd(db: Database.Database | undefined): string | undefined {
  if (!db) return undefined;
  try {
    const id = getActiveVaultId(db);
    if (!id) return undefined;
    const vault = getVault(db, id);
    if (!vault) return undefined;
    if (!fs.existsSync(vault.path)) return undefined;
    return vault.path;
  } catch {
    return undefined;
  }
}
