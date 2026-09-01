/**
 * Third-party model provider presets for Claude Code.
 *
 * Each preset configures environment variables so that Claude Code proxies
 * through the selected provider:
 * - ANTHROPIC_BASE_URL: API endpoint (must be Anthropic Messages API compatible)
 * - ANTHROPIC_AUTH_TOKEN: authentication token (Claude Code uses this for 3rd-party providers)
 * - ANTHROPIC_API_KEY: kept in sync with AUTH_TOKEN for backward compatibility
 * - ANTHROPIC_DEFAULT_SONNET_MODEL / HAIKU_MODEL / OPUS_MODEL: model name mapping
 *   (Claude Code internally uses sonnet/haiku/opus aliases; these env vars map them
 *    to the provider's actual model identifiers)
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
  /**
   * Default model mapping for Claude Code internal aliases.
   * Claude Code routes all requests through sonnet/haiku/opus aliases;
   * these env vars tell it which provider model to use for each alias.
   */
  defaultModelMapping?: {
    sonnet?: string;
    haiku?: string;
    opus?: string;
  };
  /** Whether sonnet/opus should opt into the provider's 1M context suffix. */
  useOneMContextSuffix?: boolean;
}

export const CLAUDE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ],
    apiKeyHint: 'sk-...',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    defaultModelMapping: {
      sonnet: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-flash',
      opus: 'deepseek-v4-pro',
    },
    useOneMContextSuffix: true,
  },
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
    defaultModelMapping: {
      sonnet: 'anthropic/claude-sonnet-4',
      haiku: 'anthropic/claude-sonnet-4',
      opus: 'anthropic/claude-opus-4',
    },
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
    defaultModelMapping: {
      sonnet: 'deepseek-ai/DeepSeek-V3',
      haiku: 'deepseek-ai/DeepSeek-V3',
      opus: 'deepseek-ai/DeepSeek-R1',
    },
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
  if (!baseUrl) return 'deepseek';

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
 *
 * For Anthropic official: clears all proxy-related env vars.
 * For third-party providers: sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN
 * (the correct auth var for Claude Code 3rd-party providers),
 * ANTHROPIC_API_KEY (backward compat), and model mapping env vars.
 */
export function buildProviderEnv(
  providerId: string,
  apiKey: string,
  customBaseUrl?: string,
  modelMapping?: { sonnet?: string; haiku?: string; opus?: string },
): Record<string, string> {
  if (!providerId || providerId === 'anthropic') {
    // Anthropic official: clear all proxy env vars
    return {
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: '',
      ANTHROPIC_MODEL: '',
    };
  }

  const provider = CLAUDE_PROVIDERS.find((p) => p.id === providerId);
  const baseUrl = providerId === 'custom' ? (customBaseUrl ?? '') : (provider?.baseUrl ?? '');

  // Merge provider defaults with user overrides
  const mapping = {
    ...provider?.defaultModelMapping,
    ...modelMapping,
  };
  const sonnetModel = mapping.sonnet ?? '';
  const haikuModel = mapping.haiku ?? '';
  const opusModel = mapping.opus ?? '';

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    // Claude Code uses ANTHROPIC_AUTH_TOKEN for 3rd-party providers
    ANTHROPIC_AUTH_TOKEN: apiKey,
    // Keep ANTHROPIC_API_KEY in sync for backward compatibility
    ANTHROPIC_API_KEY: apiKey,
    // Claude Code internally routes sonnet/haiku/opus aliases to these
    // provider-specific model names. DeepSeek uses a [1M] suffix for the
    // larger sonnet/opus context window while keeping the plain model id as
    // the explicit fallback/default.
    ANTHROPIC_DEFAULT_SONNET_MODEL: formatClaudeModelId(sonnetModel, provider, 'sonnet'),
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: sonnetModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: formatClaudeModelId(opusModel, provider, 'opus'),
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: opusModel,
    ANTHROPIC_MODEL: sonnetModel,
  };
}

function formatClaudeModelId(
  modelId: string,
  provider: ProviderPreset | undefined,
  alias: 'sonnet' | 'haiku' | 'opus',
): string {
  if (!modelId) return '';
  if (provider?.useOneMContextSuffix && alias !== 'haiku') {
    return `${modelId}[1M]`;
  }
  return modelId;
}

/**
 * Codex CLI provider presets. Unlike CLAUDE_PROVIDERS (env-var based, applied
 * at spawn), these are applied by the daemon writing ~/.codex/config.toml +
 * auth.json (cc-switch style), so they also work outside Molio.
 *
 * Single source of truth: @molio/contracts (shared with the daemon's
 * codex-config.ts) — re-exported here so existing imports keep working.
 */
import { CODEX_PROVIDER_PRESETS, type CodexProviderPreset } from '@molio/contracts';

export type { CodexProviderPreset };
export const CODEX_PROVIDERS: CodexProviderPreset[] = CODEX_PROVIDER_PRESETS;
