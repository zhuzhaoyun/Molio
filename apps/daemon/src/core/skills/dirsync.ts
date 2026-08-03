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
 * Symlinks are copied as regular entries (followed), matching statSync-based
 * size accounting in the importer's limit walk.
 */
export function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Content hash of a directory tree (sorted relative paths + file bytes).
 * Symlinks are skipped here but copied by copyDirSync, so a tree containing
 * them simply never short-circuits (always rebuilds) — never a wrong result.
 */
function hashDir(dir: string): string {
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
        hash.update(fs.readFileSync(p));
        hash.update('\n');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

/** True when `destDir` exists and byte-for-byte mirrors `srcDir`. */
function isAlreadySynced(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(destDir)) return false;
  try {
    return hashDir(srcDir) === hashDir(destDir);
  } catch {
    return false; // unreadable dest → rebuild
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
 *  - Atomic swap: a rebuild copies into a temp dir first, then renames it into
 *    place, so a concurrent agent CLI never reads a half-copied skill dir.
 */
export function mirrorDirIfChanged(srcDir: string, destDir: string): boolean {
  if (isAlreadySynced(srcDir, destDir)) return false;

  const tmp = `${destDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    copyDirSync(srcDir, tmp);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmp, destDir);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
