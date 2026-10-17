// apps/web/src/utils/workSteps.ts
import type { ChatMessage, ToolEvent } from '../hooks/useChatCore';
import { classifyWritePath, writeKey, type WriteKind, type WriteRef } from './toolRefs.ts';
import { lineDiff, type DiffLine } from './diff.ts';

/** 取路径末段（/ 与 \ 都认）。 */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** 是否为「写入」类工具（产出产物/改文件），与 toolRefs.WRITE_TOOLS 语义一致。 */
function isWriteTool(name: string): boolean {
  return ['Write', 'Edit', 'EditFile', 'MultiEdit', 'Append', 'AppendFile'].includes(name);
}

/** 取工具 input 的目标路径（对齐 toolRefs.writeTarget）。 */
function writeTargetPath(tool: ToolEvent): string | null {
  const input = tool.input;
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o['file_path'] === 'string') return o['file_path'] as string;
    if (typeof o['path'] === 'string') return o['path'] as string;
  }
  if (typeof input === 'string' && input.length > 0) return input;
  return null;
}

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

/** 会话级写入：WriteRef + 会话级判定的 kind + 消息溯源。 */
export interface SessionWrite extends WriteRef {
  /** 新建 / 更新 —— 由 seenBefore 判定，不是「用了哪个工具」 */
  kind: WriteKind;
  /** 产出溯源：messageId 供面板「定位回对话」 */
  messageId: string;
}

export interface SessionOutput {
  /** 库内文档产出（classifyWritePath === 'product'）—— 面板主列表。
   *  已按归一化 path 去重、仅 done；同名文件 label 自动加父目录消歧。 */
  writes: SessionWrite[];
  /** 库内非文档写入（脚本 / 数据 / 登记元文件 INDEX.md·log.md·hot.md）—— 面板折叠区；
   *  label 同样消歧。库外写入与隐藏目录（.molio / .claude 等）不进任何一栏：
   *  它们的预览与定位必然失败。 */
  others: SessionWrite[];
  turns: number;         // assistant 消息数
}

/** 变更 tab 的单条编辑：同一路径可能有多条（新建后被后续 Edit 改），按出现顺序保留。 */
export interface ChangeEntry {
  path: string;          // 归一化 path（作 key / 展示 / 定位）
  label: string;
  toolName: string;
  kind: 'create' | 'update' | 'append';
  messageId: string;
  toolId: string;
  /** Edit/MultiEdit：old→new 的行级 diff；无则可 undefined */
  diff?: DiffLine[];
  /** 文件级概要行数（WorkBuddy 式 ±）：本条改动的增/删行数；无法统计时缺省 */
  adds?: number;
  dels?: number;
  /** 无内容可 diff（整文件覆盖的 Write 等）时给占位说明 */
  placeholder?: string;
}

/** 统计一个 diff 序列的增/删行数。 */
function countDiff(diff: DiffLine[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of diff) {
    if (l.type === 'add') adds++;
    else if (l.type === 'del') dels++;
  }
  return { adds, dels };
}

/** 文本行数（尾随换行不多算一行）。 */
function lineCount(text: string): number {
  const t = text.replace(/\r\n/g, '\n');
  return t === '' ? 0 : t.split('\n').length;
}

/** 视为「读文件」的工具 —— Write 前是否读过该路径 = 新建 vs 覆写的判据
 *  （Claude Code 有 Read-before-Write 强约束：覆写前必然 Read 过）。 */
const READ_BEFORE_WRITE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 覆写判据：该路径在本次会话里已出现过 —— 被 Read/Grep 过，或已被写过。
 * **概览（collectSessionWrites）与变更 tab（extractChanges）共用它**：两处早先各判各的，
 * 同一个 hot.md 在概览里标「新建」、在变更里标「覆写」，同一份数据两个结论。
 * 只按会话内证据判，是因为工具事件里没有「写之前文件在不在」这个信息 ——
 * 宁可保守（没读过的既有文件仍算新建），也不要凭工具名假装知道。
 */
function seenBefore(norm: string, touched: Set<string>, written: Set<string>): boolean {
  return touched.has(norm) || written.has(norm);
}

/** 伪 diff 行数上限：整文件新建的超大文件只渲染前 N 行（防 DOM 爆炸）。 */
const CREATE_DIFF_MAX_LINES = 500;

/**
 * 从会话抽取「变更序列」（供产出面板变更 tab）：逐消息、逐写入工具展开，
 * 不按 path 去重（同一文件的多次改动都要看），只保留 done、排除 isError。
 * 归一化 path 与 writeKey 一致；label 用「首次出现」时的 basename，同名文件
 * 由调用方 disambiguateLabels 消歧。每条带 adds/dels 概要（文件行合计由
 * 调用方对组内求和）。
 *
 * Write 的新建 vs 覆写判定：同会话内该路径被 Read/Glob/Grep 过、或此前已有
 * 写入记录 → 覆写（旧内容未记录，占位）；否则 → 新建，content 全文渲染为
 * +行 diff（新建的「变更」就是整个文件，无需等快照）。
 */
export function extractChanges(messages: ChatMessage[], vaultPath?: string): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  const touched = new Set<string>(); // 会话内已 Read/Glob/Grep 过的路径（归一化）
  const written = new Set<string>(); // 会话内已写入过的路径
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const t of m.tools ?? []) {
      if (t.status !== 'done' || t.isError) continue;
      const path = writeTargetPath(t);
      if (path && READ_BEFORE_WRITE_TOOLS.has(t.name)) {
        touched.add(writeKey(path, vaultPath));
        continue;
      }
      if (!isWriteTool(t.name)) continue;
      if (!path) continue;
      const input = (typeof t.input === 'object' && t.input) ? t.input as Record<string, unknown> : {};
      const norm = writeKey(path, vaultPath);
      if (!norm) continue;
      // 与概览 tab 同一分层规则：变更 tab 只展示库内文档产出，
      // 脚本/数据/构建日志/库外/隐藏目录的改动不进变更序列（badge 计数随之）。
      if (classifyWritePath(norm) !== 'product') continue;
      const entry: ChangeEntry = {
        path: norm,
        label: norm.split(/[\\/]/).pop() ?? norm,
        toolName: t.name,
        kind: t.name === 'Write' ? 'create' : (t.name === 'Append' || t.name === 'AppendFile') ? 'append' : 'update',
        messageId: m.id,
        toolId: t.id,
      };
      if (t.name === 'Edit' || t.name === 'EditFile') {
        const oldS = typeof input['old_string'] === 'string' ? input['old_string'] as string : '';
        const newS = typeof input['new_string'] === 'string' ? input['new_string'] as string : '';
        if (oldS || newS) {
          entry.diff = lineDiff(oldS, newS);
          const { adds, dels } = countDiff(entry.diff);
          entry.adds = adds;
          entry.dels = dels;
        } else {
          entry.placeholder = 'edit-no-source';
        }
      } else if (t.name === 'MultiEdit') {
        // MultiEdit：input.edits = [{old_string,new_string},...]，逐段 diff 拼接
        const edits = Array.isArray(input['edits']) ? input['edits'] as Array<Record<string, unknown>> : [];
        let diff: DiffLine[] = [];
        for (const pair of edits) {
          const oldS = typeof pair['old_string'] === 'string' ? pair['old_string'] as string : '';
          const newS = typeof pair['new_string'] === 'string' ? pair['new_string'] as string : '';
          if (oldS || newS) diff = diff.concat(lineDiff(oldS, newS));
        }
        if (diff.length > 0) {
          entry.diff = diff;
          const { adds, dels } = countDiff(diff);
          entry.adds = adds;
          entry.dels = dels;
        } else {
          entry.placeholder = 'edit-no-source';
        }
      } else if (t.name === 'Write') {
        const content = typeof input['content'] === 'string' ? input['content'] as string : '';
        const isOverwrite = seenBefore(norm, touched, written);
        if (isOverwrite) {
          // 覆写：旧内容未记录（Phase 2 快照后可对比），只给新增行数概要
          entry.kind = 'update';
          entry.adds = lineCount(content);
          entry.placeholder = 'write-overwrite';
        } else {
          // 新建：变更 = 整个文件，全文渲染为 +行（超上限截断）；空内容给占位
          const lines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');
          if (lines.length === 0) {
            entry.adds = 0;
            entry.placeholder = 'write-new-file';
          } else {
            const shown = lines.slice(0, CREATE_DIFF_MAX_LINES);
            entry.diff = shown.map((text) => ({ type: 'add' as const, text }));
            entry.adds = lines.length;
            entry.dels = 0;
            if (lines.length > CREATE_DIFF_MAX_LINES) entry.placeholder = 'diff-truncated';
          }
        }
      } else {
        // Append：新追加的行数可统计（旧文件尾部未知，不出 diff）
        const content = typeof input['content'] === 'string' ? input['content'] as string : '';
        entry.adds = lineCount(content);
        entry.placeholder = 'append-file';
      }
      written.add(norm);
      out.push(entry);
    }
  }
  return out;
}

/** label 消歧：同名文件（不同目录）在列表里用最短的「能区分开」的尾部路径。 */
export function disambiguateLabels<W extends { path: string; label: string }>(writes: W[]): void {
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
 * 会话级写入序列 —— 产出面板与会话内逐条写入视图（产物横幅）**共用的真值源**。
 *
 * 逐消息、按工具出现顺序展开（顺序敏感：先 Read 后 Write 才算覆写，Read 在 Write
 * 之后不算），按归一化 path 去重（首现保留；同一文件另一种上报形态更长时只替换展示
 * 用的 path/label，toolId 仍指首现那一步）。kind 由 seenBefore 判定 ——
 * 这与「用了哪个工具」不同：Write 覆盖既有文件照样是更新。
 */
export function collectSessionWrites(messages: ChatMessage[], vaultPath?: string): SessionWrite[] {
  const touched = new Set<string>();  // 会话内被 Read/Grep 过的路径（归一化）
  const written = new Set<string>();  // 会话内已被写过的路径
  const index = new Map<string, number>();
  const out: SessionWrite[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const t of m.tools ?? []) {
      if (t.isError || t.status !== 'done') continue;
      const raw = writeTargetPath(t);
      if (!raw) continue;
      const key = writeKey(raw, vaultPath);
      if (!key) continue;
      if (READ_BEFORE_WRITE_TOOLS.has(t.name)) {
        touched.add(key);
        continue;
      }
      if (!isWriteTool(t.name)) continue;
      const seen = index.get(key);
      if (seen !== undefined) {
        const cur = out[seen]!;
        if (raw.length > cur.path.length) out[seen] = { ...cur, path: raw, label: basename(raw) };
        written.add(key);
        continue;
      }
      index.set(key, out.length);
      out.push({
        path: raw,
        label: basename(raw),
        toolName: t.name,
        toolId: t.id,
        // Edit/MultiEdit/Append 天然是「改」；Write 才需要在会话里找覆写证据
        kind: t.name === 'Write' && !seenBefore(key, touched, written) ? 'create' : 'update',
        messageId: m.id,
      });
      written.add(key);
    }
  }
  return out;
}

/**
 * writeKey → kind 映射 —— 供逐消息视图（产物横幅）复用同一 kind 判据。
 * 横幅只拿得到自己那条消息的 tools，判不出「写之前文件在不在」，
 * 故由会话容器（ChatSessionView）算一次下发。
 */
export function buildWriteKindMap(messages: ChatMessage[], vaultPath?: string): Map<string, WriteKind> {
  return new Map(collectSessionWrites(messages, vaultPath).map((w) => [writeKey(w.path, vaultPath), w.kind]));
}

/**
 * 会话级产出聚合：把聚合维度从「最后一条 assistant 消息」扩到「整个会话所有消息」。
 * 写入序列来自 collectSessionWrites（按归一化 path 去重、仅收 done），经 classifyWritePath
 * 三层分流：库内文档进 `writes`（面板主列表）、库内脚本/数据/登记元文件（INDEX.md·log.md·
 * hot.md）进 `others`（面板折叠区）、库外与隐藏目录写入直接丢弃。
 * 外部引用（读过的文件 / 网页 URL）不进会话产出——它们已在每条消息的 SourceChips 内联展示。
 */
export function aggregateSessionOutput(messages: ChatMessage[], vaultPath?: string): SessionOutput {
  const writes: SessionWrite[] = [];
  const others: SessionWrite[] = [];
  for (const w of collectSessionWrites(messages, vaultPath)) {
    const layer = classifyWritePath(writeKey(w.path, vaultPath));
    if (layer === 'hidden') continue; // 库外写入 / 隐藏目录：预览与定位必然失败，不出现
    (layer === 'product' ? writes : others).push(w);
  }
  disambiguateLabels(writes);
  disambiguateLabels(others);
  return { writes, others, turns: messages.filter((m) => m.role === 'assistant').length };
}
