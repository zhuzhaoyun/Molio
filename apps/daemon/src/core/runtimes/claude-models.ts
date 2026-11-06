/**
 * Claude Code 实际模型解析 —— CC Switch 等工具把第三方端点与模型映射写进
 * ~/.claude/settings.json（env 块 + 顶层 model 键），Claude CLI 启动时按它
 * 解析别名。Molio 的静态 fallbackModels 看不到这层，导致模型列表与真实接入
 * 不符（用户实测：列表显示 sonnet/opus，实际全是 glm-5.3-flash）。
 *
 * 本模块读同一份配置，输出 CLI 眼中的真实模型视图，语义对齐 Claude Code
 * 自家 /model 选择器：
 *  - defaultModel：ANTHROPIC_MODEL / 顶层 model（「跟随默认」的副行素材）
 *  - 槽位映射行：ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL → 发送别名
 *    id（opus…），CLI 再按映射解析；label 显示解析后的真实模型
 *  - 解析出任何内容即整体替换静态 fallback（第三方端点上官方模型 ID 不可用）
 *  - 无任何模型相关配置 → null（调用方回退 fallbackModels）
 *
 * 合并顺序（后者覆盖）：settings.json env → Molio agent env → daemon 进程 env。
 * 与 RunManager spawn 时的 env 构建保持同一优先级直觉。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RuntimeModelOption } from '@molio/contracts';

export interface ClaudeModelsResult {
  models: RuntimeModelOption[];
  /** 「跟随默认」实际会用的模型；无法确定时缺省。 */
  defaultModel?: RuntimeModelOption;
}

/** 槽位 → 发送 id 与中文角色名（detail 用，无需 i18n——品牌名）。 */
const TIERS: Array<{ tier: string; id: string; role: string }> = [
  { tier: 'OPUS', id: 'opus', role: 'Opus' },
  { tier: 'SONNET', id: 'sonnet', role: 'Sonnet' },
  { tier: 'HAIKU', id: 'haiku', role: 'Haiku' },
  { tier: 'FABLE', id: 'fable', role: 'Fable' },
];

function readSettingsEnv(settingsDir: string): { env: Record<string, string>; model?: string } {
  try {
    const raw = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8')) as {
      env?: Record<string, unknown>;
      model?: unknown;
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env ?? {})) {
      if (typeof v === 'string') env[k] = v;
    }
    return { env, model: typeof raw.model === 'string' ? raw.model : undefined };
  } catch {
    // 文件不存在 / 损坏 → 视作无配置（进程 env 兜底）
    return { env: {} };
  }
}

export function resolveClaudeModels(opts: {
  /** 注入点（测试用）；缺省 ~/.claude。 */
  settingsDir?: string;
  /** daemon 进程 env（覆盖 settings.json）。 */
  env?: Record<string, string>;
}): ClaudeModelsResult | null {
  const dir = opts.settingsDir ?? join(homedir(), '.claude');
  const { env: fileEnv, model: fileModel } = readSettingsEnv(dir);
  const env = { ...fileEnv, ...(opts.env ?? {}) };

  const explicit = env.ANTHROPIC_MODEL ?? fileModel;
  const mappings = TIERS
    .map(({ tier, id, role }): RuntimeModelOption | null => {
      const mapped = env[`ANTHROPIC_DEFAULT_${tier}_MODEL`];
      if (!mapped) return null;
      const name = env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`] ?? mapped;
      return {
        id,
        label: name,
        detail: `${role} 映射 · ${mapped}`,
      };
    })
    .filter((m) => m !== null);

  if (!explicit && mappings.length === 0) return null;

  const models: RuntimeModelOption[] = [...mappings];
  // 显式模型若未被任何槽位行覆盖（按映射值判重），补一行「自定义模型」——
  // 语义对齐 Claude Code /model 选择器的 "Custom model" 行，发送原始 id。
  if (explicit && !mappings.some((m) => m.detail?.endsWith(`· ${explicit}`))) {
    models.push({ id: explicit, label: explicit, detail: '自定义模型' });
  }

  const defaultModel: RuntimeModelOption | undefined = explicit
    ? { id: 'default', label: explicit }
    : undefined;

  return { models, defaultModel };
}
