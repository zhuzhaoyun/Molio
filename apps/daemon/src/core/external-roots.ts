/**
 * External source roots — pure fs/path helpers.
 *
 * A vault may mount external folders as READ-ONLY source material under
 * `<vault>/external/<label>` via a real directory link (Windows junction /
 * POSIX dir symlink). This module holds only filesystem/path logic and MUST
 * NOT import db.ts, so knowledge.ts can use it without pulling in SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';

export const EXTERNAL_DIR = 'external';

export interface ExternalRootRef {
  label: string;
  target: string;
}

/** Absolute path of the managed mount directory inside a vault. */
export function externalMountDir(vaultPath: string): string {
  return path.join(vaultPath, EXTERNAL_DIR);
}

/** realpathSync that falls back to a resolved path when the target is missing. */
export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `candidate` is `root` itself or lives beneath it (separator-aware). */
export function isWithinRoot(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  return candidate === r || candidate.startsWith(r + path.sep);
}

/**
 * Readable-path boundary: a real path is allowed iff it is inside the vault or
 * inside a registered external root. Mirrors resolveRealWithinVault's contract
 * but widens it to the explicit whitelist (never to arbitrary paths).
 */
export function withinBoundary(realPath: string, vaultPath: string, roots: ExternalRootRef[]): boolean {
  if (isWithinRoot(safeRealpath(vaultPath), realPath)) return true;
  return roots.some((r) => isWithinRoot(safeRealpath(r.target), realPath));
}

/**
 * Validate a candidate external root against the vault and existing roots.
 * Throws a human-readable error when invalid. Enforces the disjointness rule
 * (Obsidian's safeguard) so files can never be reachable via two paths.
 */
export function validateExternalRoot(vaultPath: string, target: string, existing: ExternalRootRef[]): void {
  const realVault = safeRealpath(vaultPath);
  const realTarget = safeRealpath(target);
  if (!fs.existsSync(realTarget) || !fs.statSync(realTarget).isDirectory()) {
    throw new Error(`External root does not exist or is not a directory: ${target}`);
  }
  const overlaps = (a: string, b: string) => isWithinRoot(a, b) || isWithinRoot(b, a);
  if (overlaps(realVault, realTarget)) {
    throw new Error(`External root must be disjoint from the vault: ${realTarget}`);
  }
  for (const r of existing) {
    if (overlaps(safeRealpath(r.target), realTarget)) {
      throw new Error(`External root overlaps an existing root (${r.label}): ${realTarget}`);
    }
  }
}

/** Create a directory link. Windows → junction (no admin, cross-drive OK). */
export function createDirectoryLink(target: string, linkPath: string): void {
  fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Remove a directory link WITHOUT touching its target. */
export function removeDirectoryLink(linkPath: string): void {
  if (process.platform === 'win32') fs.rmdirSync(linkPath);
  else fs.unlinkSync(linkPath);
}

/** True when a vault-relative path addresses the external mount namespace. */
export function isExternalMountPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return p === EXTERNAL_DIR || p.startsWith(EXTERNAL_DIR + '/');
}

/**
 * Map a virtual path `external/<label>/...` to its real path, or null when the
 * label is unknown. The caller is responsible for the realpath boundary check.
 */
export function resolveVirtualToReal(
  vaultPath: string,
  roots: ExternalRootRef[],
  relPath: string,
): string | null {
  const p = relPath.replace(/\\/g, '/');
  if (!isExternalMountPath(p)) return null;
  const rest = p.slice(EXTERNAL_DIR.length).replace(/^\/+/, '');
  if (!rest) return null;
  const slash = rest.indexOf('/');
  const label = slash === -1 ? rest : rest.slice(0, slash);
  const sub = slash === -1 ? '' : rest.slice(slash + 1);
  const root = roots.find((r) => r.label === label);
  if (!root) return null;
  return sub ? path.join(root.target, sub) : root.target;
}
