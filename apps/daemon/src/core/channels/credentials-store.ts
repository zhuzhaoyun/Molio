import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cross-channel credential file management.
 *
 * weixin and feishu each keep a JSON file under `~/.molio/<channel>-credentials.json`
 * holding their per-channel secrets (weixin: bot token + base url; feishu: tenant
 * access token + expiry). The I/O logic (atomic write via .tmp + rename, chmod
 * 0o600 on POSIX, `~` expansion for the configured path, defensive JSON parse)
 * is identical across channels — only the default filename and the per-shape
 * validation predicate differ. Centralizing it here stops the two services from
 * drifting (e.g. one forgetting the .tmp atomic write, the other skipping chmod).
 */

/** `~/.molio` — the config root shared by all channels. */
export function configDir(): string {
  return path.join(os.homedir(), '.molio');
}

/** Default credentials file path for a channel: `~/.molio/<channel>-credentials.json`. */
export function defaultCredentialsPath(channelPrefix: string): string {
  return path.join(configDir(), `${channelPrefix}-credentials.json`);
}

/**
 * Resolve the user-configured credentials path (from `config.<channel>.credentialsPath`)
 * to an absolute path. Expands a leading `~` to the home dir; falls back to
 * the channel default when unset.
 */
export function resolveCredentialsPath(
  configuredPath: string | undefined,
  channelPrefix: string,
): string {
  if (!configuredPath) return defaultCredentialsPath(channelPrefix);
  if (configuredPath.startsWith('~')) {
    return path.join(os.homedir(), configuredPath.slice(1));
  }
  return configuredPath;
}

/**
 * Read and validate a credentials file. Returns `null` when the file is
 * missing, unparseable, or fails the caller-supplied `validate` predicate.
 * The predicate is channel-specific because each channel's credentials shape
 * differs — the store stays shape-agnostic.
 */
export function readCredentials<T>(
  file: string,
  validate: (raw: unknown) => T | null,
): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validate(parsed);
  } catch {
    return null;
  }
}

/**
 * Read a credentials file as raw text (no JSON parse, no validation).
 * Returns `null` when the file is missing or unreadable. Needed by callers
 * whose on-disk format isn't always plain JSON (e.g. the auth token store's
 * encrypted envelope, which must be decrypted before parsing).
 */
export function readCredentialsRaw(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Atomically write credentials to `file`. Writes to `<file>.tmp` first, then
 * renames onto the target — a crash mid-write never leaves a half-written
 * file (a subsequent daemon restart would otherwise read a truncated JSON
 * and treat the channel as unauthenticated). chmod 0o600 on POSIX;
 * silently ignored on filesystems that don't support POSIX modes (Windows).
 */
export function writeCredentials(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows / non-POSIX filesystems ignore chmod.
  }
  fs.renameSync(tmp, file);
}

/** Remove a credentials file (best-effort — never throws). */
export function removeCredentials(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}
