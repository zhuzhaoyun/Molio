// apps/web/src/utils/workSteps.ts
import type { ChatMessage, ToolEvent } from '../hooks/useChatCore';
import { extractWrites, type WriteRef } from './toolRefs.ts';

export interface WorkStep {
  id: string;
  /** thinking | tool | generating —— 摘要清单只取 tool */
  kind: 'thinking' | 'tool' | 'generating';
  /** i18n key，渲染时 t(label) */
  label: string;
  /** 路径 / 命令 / URL，展示用（仅单步骤） */
  detail?: string;
  /** 连续同名工具数（>1 时渲染 ×N） */
  count?: number;
  /** kind==='tool' 时：组内首个工具 id，作 ToolCard 证据锚点 */
  toolId?: string;
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
 * 从单条 assistant 消息推导工作步骤（thinking → tool 组 → generating）。
 * 纯函数 —— AssistantMessage 逐消息渲染用；deriveWorkSteps 委托它。
 */
export function deriveStepsForMessage(message: ChatMessage): WorkStep[] {
  const steps: WorkStep[] = [];

  if (message.thinking && !message.content) {
    steps.push({ id: 'thinking', kind: 'thinking', label: 'workTimeline.thinking', status: message.streaming ? 'running' : 'done' });
  }

  const tools = message.tools ?? [];
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
      kind: 'tool',
      label: TOOL_LABEL[name] ?? 'workTimeline.default',
      detail: group.length > 1 ? undefined : toolDetail(group[0]!),
      count: group.length > 1 ? group.length : undefined,
      toolId: group[0]!.id,
      status: running ? 'running' : hasError ? 'error' : 'done',
    });
    i = j;
  }

  if (message.content) {
    steps.push({ id: 'generating', kind: 'generating', label: 'workTimeline.generating', status: message.streaming ? 'running' : 'done' });
  }

  return steps;
}

/**
 * 从消息列表推导当前 run 的步骤条（委托 findLastAssistant + deriveStepsForMessage）。
 * 保留导出：既有调用方签名不变。
 */
export function deriveWorkSteps(messages: ChatMessage[]): WorkStep[] {
  const last = findLastAssistant(messages);
  return last ? deriveStepsForMessage(last) : [];
}

export interface SessionOutput {
  /** 来自 extractWrites —— 已按归一化 path 去重、仅 done；messageId 用于「定位回对话」溯源；
   *  同名文件（如 wiki/INDEX.md 与 sources/INDEX.md）label 自动加父目录消歧。 */
  writes: (WriteRef & { messageId: string })[];
  turns: number;         // assistant 消息数
}

/**
 * 把 agent 上报的路径归一化为去重 key：Windows 分隔符统一、剥 ./ 前缀、
 * vault 内绝对路径还原为相对（与 daemon toVaultRelativePath 同一语义，轻量版）。
 * Write 工具的上报形态不稳定（同文件可能被先报相对后报绝对），不去重会重复列出。
 */
function writeKey(rawPath: string, vaultPath?: string): string {
  let p = rawPath.replace(/\\/g, '/');
  p = p.replace(/^\.\/+/, '');
  if (vaultPath) {
    const vp = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(`${vp}/`)) p = p.slice(vp.length + 1);
    else if (p === vp) p = '';
  }
  return p;
}

/** label 消歧：同名文件（不同目录）在列表里用最短的「能区分开」的尾部路径。 */
function disambiguateLabels<W extends { path: string; label: string }>(writes: W[]): void {
  const byLabel = new Map<string, W[]>();
  for (const w of writes) {
    const list = byLabel.get(w.label) ?? [];
    list.push(w);
    byLabel.set(w.label, list);
  }
  for (const [, group] of byLabel) {
    if (group.length < 2) continue;
    let depth = 1;
    while (depth < 6) {
      const keys = new Set(group.map((w) => w.path.split('/').slice(-depth).join('/')));
      if (keys.size === group.length) break;
      depth++;
    }
    for (const w of group) w.label = w.path.split('/').slice(-depth).join('/');
  }
}

/**
 * 会话级产出聚合：把聚合维度从「最后一条 assistant 消息」扩到「整个会话所有消息」。
 * 产出 = 本次会话 Molio 写入的 KB 文件（复用 extractWrites：按 path 去重、仅收 done）。
 * 外部引用（读过的文件 / 网页 URL）不进会话产出——它们已在每条消息的 SourceChips 内联展示。
 * 逐消息抽取并挂 messageId（首现去重），供产出面板「定位回对话」溯源。
 */
export function aggregateSessionOutput(messages: ChatMessage[], vaultPath?: string): SessionOutput {
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const seen = new Map<string, string>(); // key → 已收录的原始 path
  const writes: (WriteRef & { messageId: string })[] = [];
  for (const m of assistantMsgs) {
    // extractWrites 只按 status 过滤（running/error status 被排除），
    // 但 isError=true 且 status='done' 的异常工具不在其列 —— 会话聚合层统一再滤一次。
    for (const w of extractWrites((m.tools ?? []).filter((t) => !t.isError))) {
      const key = writeKey(w.path, vaultPath);
      if (key && seen.has(key)) {
        // 同一文件的另一种上报形态 —— 若先前只报了无扩展名/短形式，保留更完整的一条
        const prev = seen.get(key)!;
        if (w.path.length > prev.length) {
          const idx = writes.findIndex((x) => x.path === prev);
          if (idx >= 0 && writes[idx]) writes[idx] = { ...w, messageId: m.id };
          seen.set(key, w.path);
        }
        continue;
      }
      if (key) seen.set(key, w.path);
      writes.push({ ...w, messageId: m.id });
    }
  }
  disambiguateLabels(writes);
  return { writes, turns: assistantMsgs.length };
}
