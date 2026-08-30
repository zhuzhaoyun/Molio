/**
 * Codex CLI provider config management (cc-switch style).
 *
 * Codex CLI reads only ~/.codex/config.toml + ~/.codex/auth.json — it ignores
 * ANTHROPIC_* env injection for provider routing. So Molio writes these files
 * directly when the user saves a provider in the Runtimes UI:
 *
 *   - config.toml: merged write — only `model`, `model_provider` and
 *     `[model_providers.custom]` are replaced; everything else (e.g.
 *     `[projects.*]` trust entries) is preserved.
 *   - auth.json: merged write — only OPENAI_API_KEY is set/updated.
 *
 * Both files are backed up before writing and restored on failure.
 *
 * Notes:
 * - Symlinked config.toml/auth.json are replaced by regular files on write
 *   and on restore (inherent to tmp + rename).
 * - No cross-process locking — single-user local daemon assumption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'smol-toml';
import {
  CODEX_PROVIDER_PRESETS,
  getCodexPreset,
  type CodexPresetId,
  type CodexWireApi,
} from '@molio/contracts';

export type { CodexWireApi, CodexPresetId } from '@molio/contracts';

export interface CodexProviderState {
  presetHint: CodexPresetId;
  baseUrl: string | null;
  model: string | null;
  wireApi: string | null;
  hasKey: boolean;
}

/** Validation / parse problems (→ HTTP 400). Anything else surfaces as 500. */
export class CodexConfigError extends Error {}

function codexDirOrDefault(codexDir?: string): string {
  return codexDir ?? path.join(os.homedir(), '.codex');
}

const configTomlPath = (dir: string): string => path.join(dir, 'config.toml');
const authJsonPath = (dir: string): string => path.join(dir, 'auth.json');

function readConfigTable(codexDir: string): Record<string, unknown> {
  const p = configTomlPath(codexDir);
  if (!fs.existsSync(p)) return {};
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim()) return {};
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new CodexConfigError(
      `${p} is not valid TOML: ${(err as Error).message}`,
    );
  }
}

function matchPreset(baseUrl: string | null): CodexPresetId {
  if (!baseUrl) return 'custom';
  for (const preset of CODEX_PROVIDER_PRESETS) {
    // official/custom have no fixed endpoint — never match on URL
    if (!preset.baseUrl) continue;
    if (baseUrl.startsWith(preset.baseUrl)) return preset.id;
  }
  return 'custom';
}

export function getCodexProviderState(codexDir?: string): CodexProviderState {
  const dir = codexDirOrDefault(codexDir);
  let model: string | null = null;
  let baseUrl: string | null = null;
  let wireApi: string | null = null;
  let presetHint: CodexPresetId = 'official';
  try {
    const table = readConfigTable(dir);
    if (typeof table['model'] === 'string') model = table['model'];
    const mp = typeof table['model_provider'] === 'string' ? table['model_provider'] : null;
    if (mp) {
      const providers = (table['model_providers'] ?? {}) as Record<string, Record<string, unknown>>;
      const section = providers[mp];
      if (typeof section?.['base_url'] === 'string') baseUrl = section['base_url'];
      if (typeof section?.['wire_api'] === 'string') wireApi = section['wire_api'];
      presetHint = matchPreset(baseUrl);
    }
  } catch {
    // unreadable / malformed — report default state
  }
  let hasKey = false;
  try {
    const p = authJsonPath(dir);
    if (fs.existsSync(p)) {
      const auth = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      hasKey = typeof auth['OPENAI_API_KEY'] === 'string'
        && (auth['OPENAI_API_KEY'] as string).trim() !== '';
    }
  } catch {
    // malformed auth.json — treat as no key
  }
  return { presetHint, baseUrl, model, wireApi, hasKey };
}

export interface ApplyCodexProviderOpts {
  presetId: CodexPresetId;
  apiKey?: string;
  baseUrl?: string;   // required for custom
  model?: string;     // required for non-official
  wireApi?: CodexWireApi;
}

function defaultBackupDir(): string {
  return path.join(os.homedir(), '.molio', 'backups', 'codex');
}

/* ── atomic writes ── */

function atomicWriteText(target: string, content: string): void {
  const tmpFile = `${target}.tmp`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  fs.renameSync(tmpFile, target);
}

function atomicWriteJson0600(target: string, data: unknown): void {
  const tmpFile = `${target}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmpFile, 0o600); } catch { /* non-POSIX fs */ }
  }
  fs.renameSync(tmpFile, target);
}

/* ── backup / restore ── */

/** Capture of one file's pre-call state, used for rollback. */
interface BackupEntry {
  target: string;
  /** null → the file did not exist before the call. */
  bak: string | null;
}

/**
 * Snapshot a file before mutation. Returns null for non-file targets
 * (e.g. a directory) — those are neither backed up nor touched on restore.
 * The .bak itself is written atomically (.tmp + rename) so a crash mid-copy
 * never truncates the previous backup.
 */
function captureBackup(src: string, backupDir: string): BackupEntry | null {
  if (!fs.existsSync(src)) return { target: src, bak: null };
  if (!fs.statSync(src).isFile()) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const bak = path.join(backupDir, `${path.basename(src)}.bak`);
  const bakTmp = `${bak}.tmp`;
  fs.copyFileSync(src, bakTmp);
  fs.renameSync(bakTmp, bak);
  return { target: src, bak };
}

/**
 * Restore one captured entry. Skips the write when the target already matches
 * the backup (validation-only failures must not churn mtimes). Never deletes
 * anything except a regular file this call may have created.
 */
function restoreEntry(entry: BackupEntry, mode?: number): void {
  if (entry.bak === null) {
    if (fs.existsSync(entry.target) && fs.statSync(entry.target).isFile()) {
      fs.rmSync(entry.target);
    }
    return;
  }
  const bakContent = fs.readFileSync(entry.bak);
  if (
    fs.existsSync(entry.target) &&
    fs.statSync(entry.target).isFile() &&
    fs.readFileSync(entry.target).equals(bakContent)
  ) {
    return;
  }
  const tmpFile = `${entry.target}.tmp`;
  fs.writeFileSync(tmpFile, bakContent);
  if (mode !== undefined && process.platform !== 'win32') {
    try { fs.chmodSync(tmpFile, mode); } catch { /* non-POSIX fs */ }
  }
  fs.renameSync(tmpFile, entry.target);
}

/* ── merged writes ── */

function writeMergedConfig(
  codexDir: string,
  opts: { name: string; baseUrl: string; model: string; wireApi: CodexWireApi },
): void {
  const table = readConfigTable(codexDir);
  table['model'] = opts.model;
  table['model_provider'] = 'custom';
  const existingProviders = table['model_providers'];
  if (Array.isArray(existingProviders)) {
    throw new CodexConfigError('Unsupported config.toml shape: model_providers is an array of tables');
  }
  const providers = (existingProviders ?? {}) as Record<string, unknown>;
  providers['custom'] = {
    name: opts.name,
    base_url: opts.baseUrl,
    wire_api: opts.wireApi,
    requires_openai_auth: true,
  };
  table['model_providers'] = providers;
  const text = `${stringify(table)}\n`;
  parse(text); // round-trip validation before touching the real file
  atomicWriteText(configTomlPath(codexDir), text);
}

function writeClearedConfig(codexDir: string): void {
  const table = readConfigTable(codexDir);
  delete table['model'];
  delete table['model_provider'];
  const providers = table['model_providers'] as Record<string, unknown> | undefined;
  if (providers && typeof providers === 'object') {
    delete providers['custom'];
    if (Object.keys(providers).length === 0) delete table['model_providers'];
  }
  const text = Object.keys(table).length === 0 ? '' : `${stringify(table)}\n`;
  if (text) parse(text);
  const cfgPath = configTomlPath(codexDir);
  if (text === '' && !fs.existsSync(cfgPath)) return;
  atomicWriteText(cfgPath, text);
}

function mergeAuthKey(codexDir: string, apiKey: string): void {
  const p = authJsonPath(codexDir);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (parseErr) {
      throw new CodexConfigError(`${p} is not valid JSON: ${(parseErr as Error).message}`);
    }
  }
  existing['OPENAI_API_KEY'] = apiKey;
  atomicWriteJson0600(p, existing);
}

export function applyCodexProvider(
  opts: ApplyCodexProviderOpts,
  codexDir?: string,
  backupDir?: string,
): void {
  const dir = codexDirOrDefault(codexDir);
  const bdir = backupDir ?? defaultBackupDir();
  const cfgPath = configTomlPath(dir);
  const authPath = authJsonPath(dir);

  fs.mkdirSync(dir, { recursive: true });
  const captures: BackupEntry[] = [];
  const cfgCapture = captureBackup(cfgPath, bdir);
  if (cfgCapture) captures.push(cfgCapture);
  const authCapture = captureBackup(authPath, bdir);
  if (authCapture) captures.push(authCapture);

  try {
    if (opts.presetId === 'official') {
      writeClearedConfig(dir);
    } else {
      let baseUrl: string;
      let name: string;
      let wireApi: CodexWireApi;
      if (opts.presetId === 'custom') {
        if (!opts.baseUrl?.trim()) {
          throw new CodexConfigError('baseUrl is required for the custom provider');
        }
        baseUrl = opts.baseUrl.trim();
        name = 'custom';
        wireApi = opts.wireApi === 'chat' ? 'chat' : 'responses';
      } else {
        // Presets live in @molio/contracts (shared with the web UI). The old
        // server-side record only held deepseek/dashscope, so keep rejecting
        // everything that has no fixed endpoint (unknown ids, official, custom).
        const preset = getCodexPreset(opts.presetId);
        if (!preset || !preset.baseUrl) {
          throw new CodexConfigError(`Unknown codex provider preset: ${opts.presetId}`);
        }
        baseUrl = preset.baseUrl;
        name = preset.id;
        wireApi = preset.wireApi;
      }
      if (!opts.model?.trim()) throw new CodexConfigError('model is required');
      writeMergedConfig(dir, { name, baseUrl, model: opts.model.trim(), wireApi });
    }
    if (opts.apiKey && opts.apiKey.trim()) mergeAuthKey(dir, opts.apiKey.trim());
  } catch (err) {
    const restoreFailures: unknown[] = [];
    for (const entry of captures) {
      try {
        restoreEntry(entry, entry.target === authPath ? 0o600 : undefined);
      } catch (restoreErr) {
        restoreFailures.push(restoreErr);
      }
    }
    if (restoreFailures.length > 0) {
      // A failed rollback is worse than the original error — surface both.
      throw new Error(
        `Rollback incomplete after: ${(err as Error).message} — restore failed: ` +
        `${(restoreFailures[0] as Error).message}. Check ${bdir} for backups.`,
        { cause: err },
      );
    }
    throw err;
  }
}
