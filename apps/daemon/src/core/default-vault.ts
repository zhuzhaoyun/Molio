/**
 * Default vault auto-provisioning for containerized / headless deployments.
 *
 * On desktop, users create their first vault manually — and can browse for a
 * folder via Electron's directory picker. In a Docker/NAS deployment there is
 * no folder picker, and the vault must point at a container-internal mount
 * path (the daemon reads the container filesystem, not the NAS host). So a
 * fresh install would otherwise land on an empty "welcome" screen with no
 * guidance, and a user who types the NAS host path would silently write into
 * the container's ephemeral layer and lose data on the next recreate.
 *
 * To make one-click deploy work out of the box, on first boot (empty vault
 * list) we auto-create a default vault pointing at the mounted documents
 * directory — either an explicit MOLIO_DEFAULT_VAULT_PATH or the conventional
 * `/vaults` mount used by docker-compose.yml / install.sh.
 *
 * This is a strict no-op when any vault already exists, so it never touches an
 * established installation, and it never auto-creates into an arbitrary path
 * (the conventional mount is only used when it already exists as a directory).
 */

import fs from 'node:fs';
import type { Vault } from '@molio/contracts';
import type Database from 'better-sqlite3';
import { listVaults, createVault, addKbHistory, setActiveVaultId } from './db.js';
import { ensureVaultDir } from './knowledge.js';
import { installBuiltinSkills } from './skill-installer.js';

/** Minimal watcher surface needed to start watching the new vault. */
interface VaultWatcherLike {
  watch(vaultId: string, vaultPath: string): unknown;
}

export interface DefaultVaultOptions {
  /** Explicit vault path; takes precedence over the convention path. */
  explicitPath?: string;
  /** Conventional mount path checked for existence (default: '/vaults'). */
  conventionPath?: string;
  /** Display name for the created vault. */
  name?: string;
  /** Optional description. */
  description?: string;
  /**
   * Skill installer override; defaults to installBuiltinSkills. Injectable so
   * tests can simulate an installer failure without filesystem permission
   * tricks (which are unreliable across platforms, e.g. Windows read-only
   * attributes don't reliably deny the owner).
   */
  installSkills?: (vaultPath: string) => void;
}

const DEFAULT_CONVENTION_PATH = '/vaults';
const DEFAULT_VAULT_NAME = '我的知识库';
const DEFAULT_VAULT_DESCRIPTION = 'Molio 默认知识库';

/**
 * Create a default vault on first run for headless/container deployments.
 *
 * Resolution order for the vault path:
 *   1. `opts.explicitPath` (or the MOLIO_DEFAULT_VAULT_PATH env var) — used
 *      verbatim (created if missing, matching manual vault creation).
 *   2. The conventional mount path (`/vaults`) — but ONLY if it already exists
 *      as a directory, so we never fabricate a folder inside the container's
 *      ephemeral layer when nothing is actually mounted there.
 *
 * Returns the created Vault, or null when nothing was created — either because
 * vaults already exist (not a first run) or no usable default path was found.
 * Idempotent: safe to call on every startup.
 */
export function maybeCreateDefaultVault(
  db: Database.Database,
  vaultWatcher: VaultWatcherLike,
  opts: DefaultVaultOptions = {},
): Vault | null {
  // Never touch an existing installation.
  if (listVaults(db).length > 0) return null;

  const explicit = opts.explicitPath ?? process.env['MOLIO_DEFAULT_VAULT_PATH'];
  const convention = opts.conventionPath ?? DEFAULT_CONVENTION_PATH;

  let defaultPath: string | null = null;
  if (explicit && explicit.trim()) {
    defaultPath = explicit.trim();
  } else if (isExistingDir(convention)) {
    defaultPath = convention;
  }
  if (!defaultPath) return null;

  const installSkills = opts.installSkills ?? installBuiltinSkills;

  ensureVaultDir(defaultPath);
  const name = opts.name ?? DEFAULT_VAULT_NAME;
  const vault = createVault(db, name, defaultPath, opts.description ?? DEFAULT_VAULT_DESCRIPTION);
  // Skill installation writes into <vault>/.claude/skills. On NAS/Docker the
  // mounted docs dir is frequently owned by root while the daemon runs
  // unprivileged (the Dockerfile drops to a non-root user), so this can fail
  // with EACCES. That must NOT abort provisioning: the vault row is already
  // created above, and throwing here would skip setActiveVaultId below —
  // leaving the user on the empty welcome screen even though the vault exists.
  // Degrade to a warning and continue; skills can be (re)installed later once
  // the mount permissions are fixed.
  try {
    installSkills(defaultPath);
  } catch (err) {
    console.warn(
      `[default-vault] vault "${vault.name}" created at ${defaultPath}, but built-in skill ` +
        `installation failed — likely a write-permission problem on the mounted directory ` +
        `(make sure the daemon user can write to it). The vault is still usable; skills ` +
        `will be installed on a later start. Cause:`,
      err instanceof Error ? err.message : err,
    );
  }
  addKbHistory(db, vault.id, 'edit', `Default vault "${vault.name}" auto-created at ${defaultPath}`);
  void vaultWatcher.watch(vault.id, vault.path);
  // Select it so external clients (Web Clipper) and a fresh browser session
  // land inside the vault instead of the empty welcome screen.
  setActiveVaultId(db, vault.id);
  return vault;
}

function isExistingDir(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
