/**
 * Third-party model provider presets for Claude Code.
 * Each preset configures ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY
 * environment variables so that Claude Code proxies through the selected provider.
 */

export interface ProviderPreset {
  id: string;
  name: string;
  /** Base URL for the API. Empty string = use default (Anthropic official). */
  baseUrl: string;
  /** Available models for this provider. */
  models: { id: string; label: string }[];
  /** Hint text for API key input (e.g. "sk-..." prefix). */
  apiKeyHint?: string;
  /** Link to the provider's API key page. */
  apiKeyUrl?: string;
  /** Link to provider docs. */
  docsUrl?: string;
}

export const CLAUDE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    models: [
      { id: 'default', label: 'Default' },
      { id: 'sonnet', label: 'Sonnet (alias)' },
      { id: 'opus', label: 'Opus (alias)' },
      { id: 'haiku', label: 'Haiku (alias)' },
      { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
      { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    ],
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
    ],
    apiKeyHint: 'sk-...',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3' },
      { id: 'google/gemini-2.5-pro-preview', label: 'Gemini 2.5 Pro' },
    ],
    apiKeyHint: 'sk-or-...',
    apiKeyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B' },
    ],
    apiKeyHint: 'sk-...',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/',
  },
  {
    id: 'custom',
    name: 'Custom',
    baseUrl: '',
    models: [],
    docsUrl: undefined,
  },
];

/**
 * Detect which provider preset matches the given env config.
 * Returns the provider ID or 'anthropic' if no custom base URL is set.
 */
export function detectProvider(env: Record<string, string>): string {
  const baseUrl = env['ANTHROPIC_BASE_URL']?.trim();
  if (!baseUrl) return 'anthropic';

  for (const provider of CLAUDE_PROVIDERS) {
    if (provider.id === 'anthropic' || provider.id === 'custom') continue;
    if (provider.baseUrl && baseUrl.startsWith(provider.baseUrl)) {
      return provider.id;
    }
  }

  return 'custom';
}

/**
 * Build the env vars to persist for a given provider selection.
 */
export function buildProviderEnv(
  providerId: string,
  apiKey: string,
  customBaseUrl?: string,
): Record<string, string> {
  const provider = CLAUDE_PROVIDERS.find((p) => p.id === providerId);

  if (!provider || providerId === 'anthropic') {
    // Anthropic official: clear proxy env vars
    return {
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_API_KEY: '',
    };
  }

  const baseUrl = providerId === 'custom' ? (customBaseUrl ?? '') : provider.baseUrl;

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
  };
}
