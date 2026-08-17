// apps/web/src/utils/toolRefs.ts
import type { ToolEvent } from '../hooks/useChatCore';

export type SourceKind = 'file' | 'url';

export interface SourceRef {
  kind: SourceKind;
  /** 文件相对路径或完整 URL */
  target: string;
  /** 展示 label：文件名（file）或 host（url） */
  label: string;
  toolName: string;
  /** Glob pattern 等非文件目标不可点击跳转 */
  navigable: boolean;
}

/** 从 WebSearch tool_result 文本抽取 URL。中英文标点/括号/引号处截断，兼容富文本行内链接 */
const URL_RE = /https?:\/\/[^\s"'<>)\]），。]+/g;
/** 单条 assistant 消息内 URL 类 chip 上限，超出静默丢弃，防 chip 爆炸 */
const MAX_URL_CHIPS = 8;

const SOURCE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']);

/** Bash 只认 `cat/head/tail/less <path>` 这类读文件命令，其余命令不产出来源 */
function catPathFromCommand(cmd: string): string | null {
  const m = cmd.trim().match(/^(?:cat|head|tail|less)(?:\s+-\S+)*\s+(\S+)/);
  return m ? m[1] : null;
}

function sourceTarget(tool: ToolEvent): { target: string; navigable: boolean } | null {
  const input = tool.input;
  if (tool.name === 'Bash') {
    const cmd = typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['command']
      : typeof input === 'string' ? input : undefined;
    if (typeof cmd === 'string') {
      const p = catPathFromCommand(cmd);
      return p ? { target: p, navigable: true } : null;
    }
    return null;
  }
  let raw: unknown = null;
  let navigable = true;
  if (typeof input === 'string') {
    raw = input;
  } else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o['file_path'] === 'string') raw = o['file_path'];
    else if (tool.name === 'Glob' && typeof o['pattern'] === 'string') { raw = o['pattern']; navigable = false; }
    else if (typeof o['path'] === 'string') raw = o['path'];
    else if (tool.name === 'WebFetch' && typeof o['url'] === 'string') raw = o['url'];
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return { target: raw, navigable };
}

/**
 * 从一条 assistant 消息的 tools 抽取「引用」：Read/Grep/Bash(cat) → 文件，WebFetch → URL，
 * Glob → 搜索 pattern（不可跳转），WebSearch → result 文本内每条 URL 一个 chip。
 * 按 target 去重，仅保留完成（done）的工具 —— running 中的等完成后再显示，
 * error（tool_result isError）的不当作引用。URL 类 chip 上限 MAX_URL_CHIPS，超出静默丢弃。
 */
export function extractSources(tools: ToolEvent[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  let urlChips = 0;
  for (const t of tools) {
    if (t.status !== 'done') continue;
    // WebSearch 从 result 文本抽 URL：一条工具可产多条 URL，每条一个独立 chip
    if (t.name === 'WebSearch') {
      const result = t.result;
      if (typeof result !== 'string' || result.length === 0) continue;
      for (const url of result.match(URL_RE) ?? []) {
        if (urlChips >= MAX_URL_CHIPS || seen.has(url)) continue;
        seen.add(url); urlChips++;
        out.push({
          kind: 'url',
          target: url,
          label: url.replace(/^https?:\/\//, '').split('/')[0]!,
          toolName: t.name,
          navigable: true,
        });
      }
      continue;
    }
    if (!SOURCE_TOOLS.has(t.name)) continue;
    const hit = sourceTarget(t);
    if (!hit) continue;
    const isUrl = /^https?:\/\//.test(hit.target);
    if (seen.has(hit.target)) continue;
    if (isUrl && urlChips >= MAX_URL_CHIPS) continue;
    seen.add(hit.target);
    if (isUrl) urlChips++;
    out.push({
      kind: isUrl ? 'url' : 'file',
      target: hit.target,
      label: isUrl ? hit.target.replace(/^https?:\/\//, '').split('/')[0]! : hit.target.split(/[\\/]/).pop() ?? hit.target,
      toolName: t.name,
      // URL 恒可点（外部打开不依赖 vault）；文件/pattern 沿用 hit.navigable
      navigable: isUrl ? true : hit.navigable,
    });
  }
  return out;
}

export type WriteKind = 'create' | 'update';

export interface WriteRef {
  kind: WriteKind;
  path: string;
  label: string;
  toolName: string;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'EditFile', 'MultiEdit', 'Append', 'AppendFile']);

function writeTarget(tool: ToolEvent): string | null {
  const input = tool.input;
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o['file_path'] === 'string') return o['file_path'] as string;
    if (typeof o['path'] === 'string') return o['path'] as string;
  }
  if (typeof input === 'string' && input.length > 0) return input;
  return null;
}

/**
 * 从一条 assistant 消息的 tools 抽取「产物」：Write → 新文件（create），
 * Edit/EditFile/MultiEdit/Append/AppendFile → 更新（update）。按 path 去重。
 * 仅保留完成（done）的工具 —— error（tool_result isError）的不当作已写入产物，
 * 避免 banner 标题「已完成，产出已写入知识库」在写入失败时误导用户。
 * 与 extractSources 共用 target 抽取风格，方向 D 与 B 同一 util 文件。
 */
export function extractWrites(tools: ToolEvent[]): WriteRef[] {
  const seen = new Set<string>();
  const out: WriteRef[] = [];
  for (const t of tools) {
    if (!WRITE_TOOLS.has(t.name)) continue;
    if (t.status !== 'done') continue;
    const path = writeTarget(t);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({
      kind: t.name === 'Write' ? 'create' : 'update',
      path,
      label: path.split(/[\\/]/).pop() ?? path,
      toolName: t.name,
    });
  }
  return out;
}
