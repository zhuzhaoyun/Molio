/**
 * Built-in sample vault — the activation path for brand-new installs.
 *
 * A new user has no material of their own, so "create a vault and import
 * something" is a dead end until they go find files. This provisions a small
 * ready-made vault (manual + two sample notes) and opens its entry document,
 * giving them a working loop in under a minute.
 *
 * Rules:
 *  - idempotent: an already-registered path returns the existing vault;
 *  - additive: only missing files are copied — user edits are never overwritten;
 *  - fail-clean: source validation happens before mkdir/DB writes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Vault } from '@molio/contracts';
import { listVaults, getVaultByPath, createVault, addKbHistory } from './db.js';
import { ensureVaultDir, validateVaultPath } from './knowledge.js';
import { reconcileVault } from './skills/vault-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SAMPLE_VAULT_ENTRY = '开始使用.md';
export const SAMPLE_VAULT_NAME = '示例知识库';
const SAMPLE_VAULT_DESCRIPTION = 'Molio 内置示例：先在这里体验导入与问答';

type SqliteDb = Database.Database;

export class SampleVaultPathError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SampleVaultPathError';
  }
}

export interface SampleVaultOptions {
  /** Explicit target directory. Overrides env + documents-dir resolution. */
  samplePath?: string;
  /** Electron-injected documents dir (app.getPath('documents')). */
  documentsDir?: string;
  /** Test seam for HOME resolution. */
  homeDir?: string;
  /** Explicit content source dir (tests / private deployments). */
  sourceDir?: string;
  /** Test seam; defaults to reconcileVault. */
  reconcileSkills?: (db: SqliteDb, vault: Vault) => void;
}

export interface SampleVaultResult {
  vault: Vault;
  entryFile: string;
  created: boolean;
}

export function resolveSampleVaultPath(opts: SampleVaultOptions = {}): string {
  const explicit = (opts.samplePath ?? process.env['MOLIO_SAMPLE_VAULT_PATH'] ?? '').trim();
  if (explicit) return path.resolve(explicit);

  const documents = (opts.documentsDir ?? process.env['MOLIO_DOCUMENTS_DIR'] ?? '').trim();
  if (documents) return path.join(path.resolve(documents), 'Molio', '示例知识库');

  const home = opts.homeDir ?? os.homedir();
  const conventionalDocuments = path.join(home, 'Documents');
  if (fs.existsSync(conventionalDocuments)) {
    return path.join(conventionalDocuments, 'Molio', '示例知识库');
  }
  // Never fall back into the data dir: `~/.molio/...` is a dot-directory, and
  // validateVaultPath rejects those as vault roots (tool internals are not
  // knowledge roots). That fallback made the sample-vault CTA fail outright on
  // machines with no ~/Documents (Docker, trimmed Linux). Keep the same
  // home-visible layout as above so users can find the folder they were given.
  return path.join(home, 'Molio', '示例知识库');
}

function isSampleVaultSource(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, SAMPLE_VAULT_ENTRY)).isFile();
  } catch {
    return false;
  }
}

/** Mirror of skill-installer's resolveSkillsSourceDir candidate order. */
export function resolveSampleVaultSourceDir(opts: { baseDir?: string } = {}): string {
  const base = opts.baseDir ?? __dirname;
  const devCandidate = path.join(base, '..', 'tools', 'sample-vault');
  if (isSampleVaultSource(devCandidate)) return devCandidate;

  const packagedCandidate = path.join(base, 'sample-vault');
  if (isSampleVaultSource(packagedCandidate)) return packagedCandidate;

  const prodCandidate = path.join(base, '..', '..', '..', 'src', 'tools', 'sample-vault');
  if (isSampleVaultSource(prodCandidate)) return prodCandidate;

  return devCandidate;
}

function resolveSourceDir(opts: SampleVaultOptions): string {
  if (opts.sourceDir) return opts.sourceDir;
  const env = (process.env['MOLIO_SAMPLE_VAULT_SOURCE_DIR'] ?? '').trim();
  if (env) return path.resolve(env);
  return resolveSampleVaultSourceDir();
}

/** Copy only files that do not exist yet — additive, never destructive. */
function copyMissingFiles(srcDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyMissingFiles(src, dest);
      continue;
    }
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(src, dest);
  }
}

export function createSampleVault(
  db: SqliteDb,
  watcher: { watch(vaultId: string, vaultPath: string): unknown },
  opts: SampleVaultOptions = {},
): SampleVaultResult {
  const vaultPath = resolveSampleVaultPath(opts);

  const existing = getVaultByPath(db, vaultPath);
  if (existing) {
    // Repair drift: if the registered sample directory lost files (partial
    // delete, failed copy), put the missing ones back. Existing user edits
    // are still never overwritten. The directory itself can be gone too — the
    // user may have deleted it from Finder while the vault row survived — so
    // recreate it first instead of letting copyFileSync hit ENOENT (and before,
    // whether the copy worked depended on readdir returning a subdirectory first).
    const sourceDir = resolveSourceDir(opts);
    if (isSampleVaultSource(sourceDir)) {
      ensureVaultDir(vaultPath);
      copyMissingFiles(sourceDir, vaultPath);
    }
    return { vault: existing, entryFile: SAMPLE_VAULT_ENTRY, created: false };
  }

  const issue = validateVaultPath(vaultPath, listVaults(db));
  if (issue) throw new SampleVaultPathError(issue.code, issue.message);

  const sourceDir = resolveSourceDir(opts);
  if (!isSampleVaultSource(sourceDir)) {
    throw new Error(`Sample vault source not found: ${sourceDir}`);
  }

  ensureVaultDir(vaultPath);
  copyMissingFiles(sourceDir, vaultPath);

  const vault = createVault(db, SAMPLE_VAULT_NAME, vaultPath, SAMPLE_VAULT_DESCRIPTION);
  try {
    (opts.reconcileSkills ?? reconcileVault)(db, vault);
  } catch {
    // Best-effort like the normal vault-create route; provisioning must not
    // be aborted because skill fan-out hit EACCES.
  }
  addKbHistory(db, vault.id, 'edit', `Sample vault "${vault.name}" created at ${vaultPath}`);
  void watcher.watch(vault.id, vault.path);

  return { vault, entryFile: SAMPLE_VAULT_ENTRY, created: true };
}
