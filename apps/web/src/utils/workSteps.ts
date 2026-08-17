// apps/web/src/utils/workSteps.ts
import type { ChatMessage, ToolEvent } from '../hooks/useChatCore';

export interface WorkStep {
  id: string;
  /** i18n key，渲染时 t(label) */
  label: string;
  /** 路径 / 命令 / URL，展示用 */
  detail?: string;
  /** 连续同名工具数（>1 时渲染 ×N） */
  count?: number;
  status: 'running' | 'done' | 'error';
}

const TOOL_LABEL: Record<string, string> = {
  Read: 'workTimeline.read',
  Glob: 'workTimeline.searchFiles',
  Grep: 'workTimeline.grep',
  Bash: 'workTimeline.bash',
  WebFetch: 'workTimeline.webFetch',
  WebSearch: 'workTimeline.webSearch',
  Write: 'workTimeline.write',
  Edit: 'workTimeline.edit',
  EditFile: 'workTimeline.edit',
  MultiEdit: 'workTimeline.edit',
  Append: 'workTimeline.append',
  AppendFile: 'workTimeline.append',
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function toolDetail(tool: ToolEvent): string | undefined {
  const input = tool.input;
  if (typeof input === 'string') return truncate(input, 60);
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o['file_path'] === 'string') return o['file_path'] as string;
    if (typeof o['path'] === 'string') return o['path'] as string;
    if (typeof o['command'] === 'string') return truncate(o['command'] as string, 60);
    if (typeof o['url'] === 'string') return o['url'] as string;
    if (typeof o['pattern'] === 'string') return o['pattern'] as string;
    if (typeof o['description'] === 'string') return truncate(o['description'] as string, 60);
  }
  return undefined;
}

/**
 * 从消息列表倒序找最后一条 assistant 消息（当前 run 的回复载体）。
 * 纯函数 —— 供 deriveWorkSteps 与主页/KB 会话共享。
 */
export function findLastAssistant(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') return m;
  }
  return null;
}

/**
 * 从消息列表推导当前 run 的步骤条。只看最后一条 assistant 消息（当前 run 的回复）：
 * thinking 无正文 →「思考中」；tools 逐组展开（连续同名合并 + count）；有正文 →「生成回复」。
 * 纯函数 —— tools 已按消息持久化，历史恢复/重挂载天然还原，不需要 run-scoped 状态。
 */
export function deriveWorkSteps(messages: ChatMessage[]): WorkStep[] {
  const last = findLastAssistant(messages);
  if (!last) return [];

  const steps: WorkStep[] = [];

  if (last.thinking && !last.content) {
    steps.push({ id: 'thinking', label: 'workTimeline.thinking', status: last.streaming ? 'running' : 'done' });
  }

  const tools = last.tools ?? [];
  let i = 0;
  while (i < tools.length) {
    const name = tools[i]!.name;
    let j = i + 1;
    while (j < tools.length && tools[j]!.name === name) j++;
    const group = tools.slice(i, j);
    const running = group.some((t) => t.status === 'running');
    const hasError = group.some((t) => t.isError);
    steps.push({
      id: `${name}-${i}`,
      label: TOOL_LABEL[name] ?? 'workTimeline.default',
      detail: group.length > 1 ? undefined : toolDetail(group[0]!),
      count: group.length > 1 ? group.length : undefined,
      status: running ? 'running' : hasError ? 'error' : 'done',
    });
    i = j;
  }

  if (last.content) {
    steps.push({ id: 'generating', label: 'workTimeline.generating', status: last.streaming ? 'running' : 'done' });
  }

  return steps;
}
