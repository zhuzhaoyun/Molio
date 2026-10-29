/**
 * 硅基流动（SiliconFlow）共享常量与模型清单。
 *
 * 单一来源：Claude Code 预设（web）、Codex 预设与 Hermes 预设（contracts）
 * 都从这里取端点、链接和模型列表，避免漂移。
 *
 * 两个协议的地址不同，不要混用：
 * - Anthropic Messages 兼容（Claude Code 用）：https://api.siliconflow.cn/
 *   官方 Claude Code 文档要求结尾带斜杠；写成 /v1（OpenAI 路径）会不通。
 * - OpenAI Chat Completions 兼容（Codex 用）：https://api.siliconflow.cn/v1
 */

export interface SiliconFlowModel {
  id: string;
  label: string;
  /**
   * 平台免费模型（有并发/速率限制）。仅用于 UI 展示与排序，
   * 不做强制校验——免费名单会随平台调整。
   */
  free?: boolean;
}

export const SILICONFLOW = {
  id: 'siliconflow',
  name: '硅基流动 SiliconFlow',
  /** Anthropic Messages 兼容根地址（Claude Code）。 */
  anthropicBaseUrl: 'https://api.siliconflow.cn/',
  /** OpenAI Chat Completions 兼容地址（Codex）。 */
  openaiBaseUrl: 'https://api.siliconflow.cn/v1',
  apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
  docsUrl: 'https://docs.siliconflow.cn/',
  /** 模型广场：查看实时免费/付费名单与完整模型名。 */
  modelPlazaUrl: 'https://cloud.siliconflow.cn/models',
} as const;

/** 推荐默认模型（免费且支持工具调用，适合 agent 流程试用）。 */
export const SILICONFLOW_DEFAULT_MODEL = 'Qwen/Qwen3-8B';

/**
 * 精选模型：免费的排前面，付费的作为进阶选项。
 * 模型名必须带命名空间前缀（如 Qwen/、deepseek-ai/），否则 404。
 */
export const SILICONFLOW_MODELS: SiliconFlowModel[] = [
  { id: 'Qwen/Qwen3-8B', label: 'Qwen3 8B', free: true },
  { id: 'THUDM/GLM-4-9B-0414', label: 'GLM-4 9B', free: true },
  { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5 7B', free: true },
  { id: 'Qwen/Qwen2.5-Coder-7B-Instruct', label: 'Qwen2.5 Coder 7B', free: true },
  { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen2.5 72B' },
];