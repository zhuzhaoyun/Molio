/**
 * Generic directory-mirroring primitives shared by both sync paths:
 *  - library/core skills → `molio--<id>/` dirs (sync.ts),
 *  - bundled skills → plain `<slug>/` whole dirs (skill-installer.ts).
 *
 * One staleness rule for both: a destination is fresh iff it byte-for-byte
 * mirrors the source (sha256 over sorted relative paths + file bytes). Any
 * drift — edited content, version bump, stale/extra siblings, corruption —
 * breaks the hash match and triggers a rebuild, so sync is self-healing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively copy a directory, overwriting files to keep them in sync.
 * Only plain files and directories are copied; symlinks and special entries
 * (FIFOs, sockets, devices) are SKIPPED — consistent with hashDir (which only
 * hashes isFile entries), so a tree containing them still hash-matches its
 * copy and the short-circuit works. Following symlinks could crash the mirror
 * (a link to a directory makes copyFileSync throw EISDIR) or leak external
 * file content into the vault; copying a FIFO blocks copyFileSync forever
 * once the read end opens it (a daemon freeze that recurs on every startup).
 */
export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
    // Symlinks / FIFOs / sockets / devices: skip (see doc comment).
  }
}

/** Chunk size for streaming file content through the hash (bounded memory). */
const HASH_CHUNK_SIZE = 64 * 1024;

/**
 * Content hash of a directory tree (sorted relative paths + file bytes).
 * Symlinks are skipped — the same rule copyDirSync applies, so a mirrored tree
 * can hash-match its source and the short-circuit works. File bytes stream
 * through the hash in fixed-size chunks: a single skill file may be ~100MB
 * (the import cap) and this runs per vault on every startup fan-out, so
 * buffering whole files would spike memory at 2× the largest file per sync.
 */
export function hashDir(dir: string): string {
  const hash = crypto.createHash('sha256');
  const walk = (d: string, rel: string): void => {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d:${r}\n`);
        walk(p, r);
      } else if (entry.isFile()) {
        hash.update(`f:${r}\n`);
        const fd = fs.openSync(p, 'r');
        try {
          const buf = Buffer.alloc(HASH_CHUNK_SIZE);
          let n: number;
          while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            hash.update(buf.subarray(0, n));
          }
        } finally {
          fs.closeSync(fd);
        }
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/**
 * True when `destDir` exists and byte-for-byte mirrors `srcDir`. Also used as
 * an OWNERSHIP PROOF before deleting a managed dir: only content identical to
 * Molio's own source is Molio's (see reconcileBundledSync step 3).
 */
export function isAlreadySynced(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(destDir)) return false;
  try {
    return hashDir(srcDir) === hashDir(destDir);
  } catch {
    return false; // unreadable dest → rebuild
  }
}

/** Matches mirrorDirIfChanged staging dirs: `<name>.tmp-<ms>-<rand>` / `.bak-…` */
const MIRROR_ARTIFACT_RE = /\.(tmp|bak)-\d+-[a-z0-9]+$/i;
/** Artifacts younger than this may belong to an in-flight mirror — leave alone. */
const STALE_ARTIFACT_MS = 5 * 60 * 1000;

/**
 * True for names that look like mirror staging artifacts (`<x>.tmp-…`/`.bak-…`).
 * Callers doing bulk cleanup (orphan sweeps) must skip these: their lifetime is
 * governed by sweepStaleMirrorArtifacts' age grace window, and deleting a
 * FRESH artifact could rm -rf a mirror another process is building right now.
 */
export function isMirrorArtifactName(name: string): boolean {
  return MIRROR_ARTIFACT_RE.test(name);
}

/**
 * Sweep orphaned `.tmp-*` / `.bak-*` staging dirs left behind when the daemon
 * died mid-mirror (SIGKILL / power loss). They sit inside the scanned
 * `.claude/skills/` dir, so runtime CLIs would pick up a half-copied skill
 * from them. Only removes directories matching the staging-name pattern and
 * older than STALE_ARTIFACT_MS — never anything else. Best-effort.
 */
export function sweepStaleMirrorArtifacts(skillsDirPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDirPath, { withFileTypes: true });
  } catch {
    return; // dir missing — nothing to sweep
  }
  const cutoff = Date.now() - STALE_ARTIFACT_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !MIRROR_ARTIFACT_RE.test(entry.name)) continue;
    const p = path.join(skillsDirPath, entry.name);
    try {
      if (fs.statSync(p).mtimeMs >= cutoff) continue; // possibly in flight
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort; a locked artifact must never abort reconciliation.
    }
  }
}

/**
 * Mirror `srcDir` into `destDir` (whole tree). Returns true when bytes were
 * written, false when `destDir` already mirrored `srcDir` and nothing happened.
 *
 * Two properties over a blind rm+copy:
 *  - Short-circuit: sync fans out to every vault on each daemon start, so an
 *    unchanged dest stays read-only — especially important on NAS-mounted
 *    vaults. Dest pollution (extra/missing/changed files) breaks the hash
 *    match → rebuild, so convergence is preserved.
 *  - Swap with rollback: a rebuild copies into a staging dir first, renames
 *    the old dest aside (backup), then renames staging into place. If the
 *    final rename fails (EPERM on ownership-changed NAS mounts, AV locks on
 *    Windows, cross-filesystem renames), the backup is renamed BACK instead
 *    of leaving the skill dir deleted — the old rm-then-rename sequence lost
 *    the previous content on exactly that failure.
 */
export function mirrorDirIfChanged(srcDir: string, destDir: string): boolean {
  if (isAlreadySynced(srcDir, destDir)) return false;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmp = `${destDir}.tmp-${stamp}`;
  const backup = `${destDir}.bak-${stamp}`;
  let hadDest = false;
  try {
    copyDirSync(srcDir, tmp);
    hadDest = fs.existsSync(destDir);
    if (hadDest) fs.renameSync(destDir, backup);
    try {
      fs.renameSync(tmp, destDir);
    } catch (err) {
      // Restore the previous copy so a failed swap degrades to "old content
      // still present", never "skill dir gone".
      if (hadDest) {
        try {
          fs.renameSync(backup, destDir);
        } catch {
          /* nothing more we can do — throw the original error below */
        }
      }
      throw err;
    }
    if (hadDest) {
      try {
        fs.rmSync(backup, { recursive: true, force: true });
      } catch {
        // Orphaned backup is swept by sweepStaleMirrorArtifacts later.
      }
    }
    return true;
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
