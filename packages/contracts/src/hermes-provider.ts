/**
 * Hermes Agent model-provider presets — single source of truth shared by:
 *
 * - daemon (`apps/daemon/src/core/runtimes/hermes-config.ts`): writes the
 *   selection into hermes-native config (`<hermes home>/config.yaml` +
 *   `.env`), so it also works outside Molio
 * - web (`apps/web/src/components/runtimes/providers.ts`): renders the
 *   provider config UI
 *
 * Both sides MUST import from here — never duplicate preset data.
 *
 * Facts encoded below come from hermes-agent's own provider registry
 * (`plugins/model-providers/<id>/__init__.py`): each profile declares its
 * `env_vars` (the `.env` key that carries the API key) and a built-in
 * default `base_url` (overridable via the per-provider `*_BASE_URL` env).
 *
 * The `custom` preset is the exception: the hermes custom profile declares
 * `env_vars=()` (no fixed key), so its API key travels as `model.api_key`
 * in config.yaml and its endpoint as `model.base_url`.
 */

export type HermesPresetId =
  | 'zai'
  | 'kimi-coding'
  | 'minimax-cn'
  | 'xiaomi'
  | 'anthropic'
  | 'openrouter'
  | 'custom';

export interface HermesProviderPreset {
  id: HermesPresetId;
  name: string;
  /** Value written to `model.provider` in config.yaml. */
  providerValue: string;
  /**
   * `.env` key carrying the API key. Undefined for `custom` — its key is
   * written as `model.api_key` in config.yaml instead (hermes custom
   * profile has no fixed env var).
   */
  envKey?: string;
  /** `.env` key for an optional base-url override (e.g. GLM_BASE_URL). */
  baseUrlEnvKey?: string;
  /**
   * Pre-filled base-url override for the UI. Empty = use hermes's built-in
   * default endpoint. The zai preset pre-fills the 国内 (bigmodel.cn)
   * endpoint because its keys don't work against the international default
   * (api.z.ai) — users with z.ai keys clear the field.
   */
  defaultBaseUrl?: string;
  /** Model suggestions for the UI. Empty = free-form input; blank = hermes default. */
  models: { id: string; label: string }[];
  /** Hint text for the API key input (e.g. "sk-..."). */
  apiKeyHint?: string;
  apiKeyUrl?: string;
  docsUrl?: string;
  isCustom?: boolean;
}

export const HERMES_PROVIDER_PRESETS: HermesProviderPreset[] = [
  {
    id: 'zai',
    name: '智谱 GLM',
    providerValue: 'zai',
    envKey: 'GLM_API_KEY',
    baseUrlEnvKey: 'GLM_BASE_URL',
    // 国内 bigmodel.cn 端点（hermes 内置默认是国际站 api.z.ai，两边 key 不通用）
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [],
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi (Moonshot)',
    providerValue: 'kimi-coding',
    envKey: 'KIMI_API_KEY',
    baseUrlEnvKey: 'KIMI_BASE_URL',
    models: [],
    apiKeyUrl: 'https://platform.kimi.ai',
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax 国内',
    providerValue: 'minimax-cn',
    envKey: 'MINIMAX_CN_API_KEY',
    baseUrlEnvKey: 'MINIMAX_CN_BASE_URL',
    models: [],
    apiKeyUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
    providerValue: 'xiaomi',
    envKey: 'XIAOMI_API_KEY',
    baseUrlEnvKey: 'XIAOMI_BASE_URL',
    models: [],
    apiKeyUrl: 'https://platform.xiaomimimo.com',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    providerValue: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: [],
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    providerValue: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    models: [],
    apiKeyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'custom',
    name: '自定义 (OpenAI 兼容)',
    providerValue: 'custom',
    models: [],
    isCustom: true,
  },
];

/** Lookup a preset by id. Returns undefined for unknown ids. */
export function getHermesPreset(id: string): HermesProviderPreset | undefined {
  return HERMES_PROVIDER_PRESETS.find((p) => p.id === id);
}
