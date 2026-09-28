/**
 * Hermes Agent model-provider config management (mirrors codex-config.ts).
 *
 * Hermes reads ONLY its native config — `<hermes home>/config.yaml` for
 * provider/model/base_url and `<hermes home>/.env` for API keys. Critically,
 * its env loader reads `.env` with `override=True`, so `.env` WINS over the
 * process environment: injecting keys at spawn time is unreliable. So Molio
 * writes these files directly when the user saves a provider in the Runtimes
 * UI — which also makes the config work for `hermes` outside Molio.
 *
 * hermes home resolution:
 *   - `HERMES_HOME` env override (honored first)
 *   - Windows: `%LOCALAPPDATA%\hermes`
 *   - POSIX:   `~/.hermes`
 *
 * Two write targets:
 *   - config.yaml: merged Document edit (comments + hermes's `_config_version`
 *     are preserved — the `yaml` package round-trips the AST, not a re-dump).
 *     Only the `model.*` keys we own are set; everything else is untouched.
 *   - .env: line upsert — only the preset's key/base-url lines are set or
 *     replaced; all other lines (and comments) are preserved verbatim.
 *
 * Both files are backed up before writing and restored on failure.
 *
 * Notes:
 * - Symlinked files are replaced by regular files on write and on restore
 *   (inherent to tmp + rename). Same as codex-config.
 * - No cross-process locking — single-user local daemon assumption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Document, parseDocument } from 'yaml';
import {
  HERMES_PROVIDER_PRESETS,
  getHermesPreset,
  type HermesPresetId,
} from '@molio/contracts';

export type { HermesPresetId } from '@molio/contracts';

export interface HermesProviderState {
  /** Matched preset id, or 'custom' when a base_url is set but nothing matches. */
  presetHint: HermesPresetId;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  /** True when an API key is present (never returns the key itself). */
  hasKey: boolean;
}

/** Validation / parse problems (→ HTTP 400). Anything else surfaces as 500. */
export class HermesConfigError extends Error {}

/**
 * Resolve the hermes home directory. Exported so tests and callers agree on
 * the same precedence: HERMES_HOME env → platform default.
 */
export function resolveHermesHome(): string {
  const override = process.env['HERMES_HOME'];
  if (override && override.trim()) return override.trim();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    if (local && local.trim()) return path.join(local.trim(), 'hermes');
    return path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function homeOrDefault(hermesHome?: string): string {
  return hermesHome ?? resolveHermesHome();
}

const configYamlPath = (dir: string): string => path.join(dir, 'config.yaml');
const envPath = (dir: string): string => path.join(dir, '.env');

/* ─── config.yaml read ─── */

interface ModelSection {
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
}

function readModelSection(hermesHome: string): ModelSection {
  const empty: ModelSection = { provider: null, baseUrl: null, model: null, apiKey: null };
  const p = configYamlPath(hermesHome);
  if (!fs.existsSync(p)) return empty;
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return empty;
  }
  if (!text.trim()) return empty;

  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch (err) {
    throw new HermesConfigError(`${p} is not valid YAML: ${(err as Error).message}`);
  }
  // parseDocument collects errors instead of throwing on some malformed input.
  if (doc.errors.length > 0) {
    throw new HermesConfigError(`${p} is not valid YAML: ${doc.errors[0]!.message}`);
  }

  const model = doc.get('model');
  if (!model || typeof model !== 'object') return empty;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  // NB: doc.get returns a YAMLMap (not a plain object) — index access would be
  // undefined; read scalars via getIn, which converts them to JS values.
  return {
    provider: str(doc.getIn(['model', 'provider'])),
    // Both `default` and `model` are accepted key names for the model id.
    model: str(doc.getIn(['model', 'default'])) ?? str(doc.getIn(['model', 'model'])),
    baseUrl: str(doc.getIn(['model', 'base_url'])),
    apiKey: str(doc.getIn(['model', 'api_key'])),
  };
}

/* ─── .env read ─── */

/**
 * Parse a KEY=VALUE line, tolerating `export ` prefix, quotes, and inline
 * comments. Returns null for blank/comment/malformed lines.
 */
function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eq = body.indexOf('=');
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = body.slice(eq + 1).trim();
  // Strip matching surrounding quotes.
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/** Read a single key's non-empty value from `.env`, or null. */
function readEnvKey(hermesHome: string, key: string): string | null {
  const p = envPath(hermesHome);
  if (!fs.existsSync(p)) return null;
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    // Last occurrence wins (dotenv semantics).
    if (parsed && parsed.key === key) found = parsed.value;
  }
  return found && found.trim() ? found : null;
}

function matchPreset(provider: string | null, baseUrl: string | null): HermesPresetId {
  if (provider) {
    for (const preset of HERMES_PROVIDER_PRESETS) {
      if (preset.providerValue === provider) return preset.id;
    }
  }
  if (baseUrl) return 'custom';
  // No provider configured yet — hermes defaults to 'auto'; surface as the
  // first preset so the UI has a sensible default selection.
  return 'custom';
}

export function getHermesProviderState(hermesHome?: string): HermesProviderState {
  const home = homeOrDefault(hermesHome);
  let section: ModelSection;
  try {
    section = readModelSection(home);
  } catch {
    // unreadable / malformed — report default state (never leak a parse error
    // into the status endpoint; apply() surfaces the real error on write).
    section = { provider: null, baseUrl: null, model: null, apiKey: null };
  }

  const presetHint = matchPreset(section.provider, section.baseUrl);
  const preset = getHermesPreset(presetHint);

  let hasKey = false;
  let baseUrl = section.baseUrl;
  if (preset?.isCustom) {
    // custom key lives in config.yaml model.api_key
    hasKey = !!section.apiKey;
  } else if (preset) {
    if (preset.envKey) hasKey = readEnvKey(home, preset.envKey) !== null;
    // Preset base-url overrides live in .env (*_BASE_URL), not config.yaml —
    // echo them back so the UI can show what was saved.
    if (!baseUrl && preset.baseUrlEnvKey) {
      baseUrl = readEnvKey(home, preset.baseUrlEnvKey);
    }
  }

  return {
    presetHint,
    provider: section.provider,
    baseUrl,
    model: section.model,
    hasKey,
  };
}

/* ─── atomic writes ─── */

function atomicWriteText(target: string, content: string, mode?: number): void {
  const tmpFile = `${target}.tmp`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  if (mode !== undefined && process.platform !== 'win32') {
    try { fs.chmodSync(tmpFile, mode); } catch { /* non-POSIX fs */ }
  }
  fs.renameSync(tmpFile, target);
}

/* ─── backup / restore (same contract as codex-config.ts) ─── */

interface BackupEntry {
  target: string;
  /** null → the file did not exist before the call. */
  bak: string | null;
}

function defaultBackupDir(): string {
  return path.join(os.homedir(), '.molio', 'backups', 'hermes');
}

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

/* ─── merged writes ─── */

/**
 * Merge our `model.*` keys into config.yaml, preserving comments, other
 * sections, and hermes's own `_config_version`. `undefined` values leave the
 * corresponding key untouched; `null` deletes it.
 */
function writeMergedConfigYaml(
  hermesHome: string,
  updates: Record<string, string | null>,
): void {
  const p = configYamlPath(hermesHome);
  let doc: Document;
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, 'utf8');
    doc = text.trim() ? parseDocument(text) : parseDocument('');
    if (doc.errors.length > 0) {
      throw new HermesConfigError(`${p} is not valid YAML: ${doc.errors[0]!.message}`);
    }
  } else {
    doc = parseDocument('');
  }
  if (doc.contents === null || doc.contents === undefined) {
    doc.contents = doc.createNode({});
  }

  // Ensure a `model` map exists.
  if (!doc.has('model') || doc.get('model') == null) {
    doc.set('model', doc.createNode({}));
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) {
      doc.deleteIn(['model', key]);
    } else {
      doc.setIn(['model', key], value);
    }
  }

  const out = doc.toString();
  parseDocument(out); // round-trip validation before touching the real file
  atomicWriteText(p, out);
}

/**
 * Upsert KEY=VALUE lines into `.env`, preserving every other line (and
 * comments) verbatim. Existing keys are replaced in place; new keys appended.
 */
function writeEnvVars(hermesHome: string, updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  const p = envPath(hermesHome);
  const remaining = new Map(Object.entries(updates));
  let lines: string[] = [];
  if (fs.existsSync(p)) {
    lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  }
  const out = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (parsed && remaining.has(parsed.key)) {
      const value = remaining.get(parsed.key)!;
      remaining.delete(parsed.key);
      // Preserve an `export ` prefix if the original line used one.
      const prefix = line.trim().startsWith('export ') ? 'export ' : '';
      return `${prefix}${parsed.key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of remaining) {
    out.push(`${key}=${value}`);
  }
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  // .env holds secrets — 0600 on POSIX.
  atomicWriteText(p, text, 0o600);
}

/* ─── public apply ─── */

export interface ApplyHermesProviderOpts {
  presetId: HermesPresetId;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function applyHermesProvider(
  opts: ApplyHermesProviderOpts,
  hermesHome?: string,
  backupDir?: string,
): void {
  const preset = getHermesPreset(opts.presetId);
  if (!preset) {
    throw new HermesConfigError(`Unknown hermes provider preset: ${opts.presetId}`);
  }

  const home = homeOrDefault(hermesHome);
  const bdir = backupDir ?? defaultBackupDir();
  const cfgPath = configYamlPath(home);
  const dotenvPath = envPath(home);

  fs.mkdirSync(home, { recursive: true });

  const model = opts.model?.trim() || undefined;
  const apiKey = opts.apiKey?.trim() || undefined;

  // Validate custom requirements up front (before any backup/write).
  let effectiveBaseUrl: string | undefined;
  if (preset.isCustom) {
    const bu = opts.baseUrl?.trim();
    if (!bu) throw new HermesConfigError('baseUrl is required for the custom provider');
    effectiveBaseUrl = bu;
  } else {
    // Presets may carry a default base url (e.g. zai → bigmodel.cn endpoint);
    // an explicit user override wins.
    effectiveBaseUrl = opts.baseUrl?.trim() || preset.defaultBaseUrl || undefined;
  }

  const captures: BackupEntry[] = [];
  const cfgCapture = captureBackup(cfgPath, bdir);
  if (cfgCapture) captures.push(cfgCapture);
  const envCapture = captureBackup(dotenvPath, bdir);
  if (envCapture) captures.push(envCapture);

  try {
    if (preset.isCustom) {
      // custom: everything lives in config.yaml model.* (no env key).
      const updates: Record<string, string | null> = {
        provider: preset.providerValue,
        base_url: effectiveBaseUrl ?? null,
      };
      if (model !== undefined) updates['default'] = model;
      if (apiKey !== undefined) updates['api_key'] = apiKey;
      writeMergedConfigYaml(home, updates);
    } else {
      // preset: provider + model in config.yaml; key/base_url in .env.
      const updates: Record<string, string | null> = {
        provider: preset.providerValue,
      };
      if (model !== undefined) updates['default'] = model;
      writeMergedConfigYaml(home, updates);

      const envUpdates: Record<string, string> = {};
      if (apiKey !== undefined && preset.envKey) envUpdates[preset.envKey] = apiKey;
      if (effectiveBaseUrl && preset.baseUrlEnvKey) {
        envUpdates[preset.baseUrlEnvKey] = effectiveBaseUrl;
      }
      writeEnvVars(home, envUpdates);
    }
  } catch (err) {
    const restoreFailures: unknown[] = [];
    for (const entry of captures) {
      try {
        restoreEntry(entry, entry.target === dotenvPath ? 0o600 : undefined);
      } catch (restoreErr) {
        restoreFailures.push(restoreErr);
      }
    }
    if (restoreFailures.length > 0) {
      throw new Error(
        `Rollback incomplete after: ${(err as Error).message} — restore failed: ` +
        `${(restoreFailures[0] as Error).message}. Check ${bdir} for backups.`,
        { cause: err },
      );
    }
    throw err;
  }
}
