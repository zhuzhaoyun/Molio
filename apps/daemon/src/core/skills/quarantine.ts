/**
 * Quarantine — the safety net under every path that would otherwise overwrite
 * or destroy user-touched skill content (vault mirror drift, cold-start diff,
 * hub refresh, retirement, orphan sweep).
 *
 * One rule: NEVER silently destroy. Before any rebuild/overwrite/removal of a
 * directory that might carry user edits, `quarantineDir` copies it to
 * `<molioHome>/skill-quarantine/<label>-<ts>-<rand>/` and `recordQuarantineEvent`
 * writes a row the settings UI surfaces. Copies are best-effort: a quarantine
 * failure logs and returns null — it must never block the reconciliation that
 * triggered it (the design doc's anti-goal: quarantine is a net, not a lock).
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { copyDirSync } from './dirsync.js';
import { defaultMolioHome, isValidSkillPathSegment, type SkillPathsOpts } from './paths.js';

/** What kind of destruction the quarantine prevented. */
export type QuarantineSource = 'vault-drift' | 'vault-cold-start' | 'hub-update' | 'retired' | 'orphan-sweep';

/** One ledger row (mirrors the `skill_quarantine_events` table). */
export interface SkillQuarantineEvent {
  id: number;
  source: QuarantineSource;
  skillId?: string;
  mirrorName: string;
  description: string;
  quarantinedPath: string;
  createdAt: number;
  acked: boolean;
}

/** Retention for quarantine copies (design §5.6). */
const QUARANTINE_RETENTION_MS = 30 * 24 * 3600 * 1000;

/** `<molioHome>/skill-quarantine` — the quarantine area root. */
export function quarantineRoot(opts?: SkillPathsOpts): string {
  return path.join(opts?.molioHome ?? defaultMolioHome(), 'skill-quarantine');
}

interface QuarantineEventRow {
  id: number;
  source: string;
  skill_id: string | null;
  mirror_name: string;
  description: string;
  quarantined_path: string;
  created_at: number;
  acked: number;
}

const SOURCES: readonly QuarantineSource[] = [
  'vault-drift',
  'vault-cold-start',
  'hub-update',
  'retired',
  'orphan-sweep',
];

function rowToEvent(row: QuarantineEventRow): SkillQuarantineEvent {
  const source = (SOURCES as readonly string[]).includes(row.source)
    ? (row.source as QuarantineSource)
    : 'vault-drift'; // unknown source degrades to the generic label
  return {
    id: row.id,
    source,
    ...(row.skill_id ? { skillId: row.skill_id } : {}),
    mirrorName: row.mirror_name,
    description: row.description,
    quarantinedPath: row.quarantined_path,
    createdAt: row.created_at,
    acked: row.acked !== 0,
  };
}

/**
 * Copy `srcDir` into the quarantine area as `<label>-<ts>-<rand>/`. Returns
 * the copy's path, or null on ANY failure (missing source, unsafe label, I/O
 * error) — never throws, per the best-effort contract.
 */
export function quarantineDir(srcDir: string, label: string, opts?: SkillPathsOpts): string | null {
  try {
    if (!isValidSkillPathSegment(label)) {
      console.warn(`[quarantine] Refusing unsafe label: ${JSON.stringify(label)}`);
      return null;
    }
    const dest = path.join(
      quarantineRoot(opts),
      `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    copyDirSync(srcDir, dest);
    return dest;
  } catch (err) {
    console.warn(
      `[quarantine] Failed to quarantine "${srcDir}" (${label}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * True when an UNACKED event with this dedupe key already exists — the exact
 * same drift was already preserved + reported, so callers skip re-copying and
 * re-reporting (the NAS-EPERM loop breaker; an acked key may fire again).
 */
export function hasUnackedQuarantineEvent(db: Database.Database, dedupeKey: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM skill_quarantine_events WHERE dedupe_key = ? AND acked = 0 LIMIT 1')
    .get(dedupeKey);
  return row !== undefined;
}

/** Append a ledger row; returns its rowid. */
export function recordQuarantineEvent(
  db: Database.Database,
  ev: {
    source: QuarantineSource;
    skillId?: string;
    mirrorName: string;
    description: string;
    quarantinedPath: string;
    /** Loop-breaker key (guarded callers: vault|mirror|content-hash). */
    dedupeKey?: string;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO skill_quarantine_events
         (source, skill_id, mirror_name, description, quarantined_path, created_at, acked, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      ev.source,
      ev.skillId ?? null,
      ev.mirrorName,
      ev.description,
      ev.quarantinedPath,
      Date.now(),
      ev.dedupeKey ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** List events, newest first. `unackedOnly` filters to rows the UI still shows. */
export function listQuarantineEvents(
  db: Database.Database,
  opts?: { unackedOnly?: boolean },
): SkillQuarantineEvent[] {
  const where = opts?.unackedOnly ? 'WHERE acked = 0' : '';
  const rows = db
    .prepare(`SELECT * FROM skill_quarantine_events ${where} ORDER BY created_at DESC, id DESC`)
    .all() as QuarantineEventRow[];
  return rows.map(rowToEvent);
}

/** Mark one event acknowledged. Returns false when the id doesn't exist. */
export function ackQuarantineEvent(db: Database.Database, id: number): boolean {
  const info = db.prepare('UPDATE skill_quarantine_events SET acked = 1 WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Delete quarantine copies older than the retention window (design: 30 days).
 * Best-effort: unreadable/locked entries are skipped, never fatal.
 */
export function cleanupExpiredQuarantine(opts?: SkillPathsOpts): void {
  const root = quarantineRoot(opts);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // no quarantine area yet — nothing to do
  }
  const cutoff = Date.now() - QUARANTINE_RETENTION_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = path.join(root, entry.name);
    try {
      if (fs.statSync(p).mtimeMs >= cutoff) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[quarantine] Failed to clean up expired entry "${entry.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
