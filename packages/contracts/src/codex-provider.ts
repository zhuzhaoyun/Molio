/**
 * Codex CLI provider presets — single source of truth shared by:
 *
 * - daemon (`apps/daemon/src/core/runtimes/codex-config.ts`): writes the
 *   selected provider into ~/.codex/config.toml + auth.json (cc-switch style)
 * - web (`apps/web/src/components/runtimes/providers.ts`): renders the
 *   provider config UI (models list, key/links)
 *
 * Both sides MUST import from here — never duplicate preset data (baseUrl
 * drift between daemon and web was the reason this moved to contracts).
 */

export type CodexWireApi = 'responses' | 'chat';
export type CodexPresetId = 'deepseek' | 'dashscope' | 'official' | 'custom';

export interface CodexProviderPreset {
  id: CodexPresetId;
  name: string;
  /** API endpoint. Empty string = no fixed endpoint (official / custom). */
  baseUrl: string;
  wireApi: CodexWireApi;
  /** Model list for the UI dropdown. Empty = free-form input or not needed. */
  models: { id: string; label: string }[];
  apiKeyHint?: string;
  apiKeyUrl?: string;
  docsUrl?: string;
  /** Official = clear Molio's override and restore Codex defaults. */
  isOfficial?: boolean;
  isCustom?: boolean;
}

export const CODEX_PROVIDER_PRESETS: CodexProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    wireApi: 'responses',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'dashscope',
    name: '阿里云 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    wireApi: 'responses',
    models: [{ id: 'qwen3-max', label: 'qwen3-max' }],
    apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'official',
    name: 'OpenAI 官方',
    baseUrl: '',
    wireApi: 'responses',
    models: [],
    isOfficial: true,
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    wireApi: 'responses',
    models: [],
    isCustom: true,
  },
];

/** Lookup a preset by id. Returns undefined for unknown ids. */
export function getCodexPreset(id: string): CodexProviderPreset | undefined {
  return CODEX_PROVIDER_PRESETS.find((p) => p.id === id);
}
