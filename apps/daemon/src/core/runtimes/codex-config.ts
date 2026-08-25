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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'smol-toml';

export type CodexWireApi = 'responses' | 'chat';
export type CodexPresetId = 'deepseek' | 'dashscope' | 'official' | 'custom';

export interface CodexPresetDef {
  name: string;
  baseUrl: string;
  wireApi: CodexWireApi;
}

/** Server-side source of truth for preset endpoints (mirrors web CODEX_PROVIDERS). */
export const CODEX_PROVIDER_PRESETS: Record<string, CodexPresetDef> = {
  deepseek: { name: 'deepseek', baseUrl: 'https://api.deepseek.com', wireApi: 'responses' },
  dashscope: { name: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', wireApi: 'responses' },
};

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
  for (const [id, preset] of Object.entries(CODEX_PROVIDER_PRESETS)) {
    if (baseUrl.startsWith(preset.baseUrl)) return id as CodexPresetId;
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
