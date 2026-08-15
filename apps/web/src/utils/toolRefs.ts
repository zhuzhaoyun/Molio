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

const SOURCE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch']);

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
 * Glob → 搜索 pattern（不可跳转）。按 target 去重，跳过 running 中的工具（完成后再显示）。
 */
export function extractSources(tools: ToolEvent[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const t of tools) {
    if (!SOURCE_TOOLS.has(t.name)) continue;
    if (t.status === 'running') continue;
    const hit = sourceTarget(t);
    if (!hit) continue;
    if (seen.has(hit.target)) continue;
    seen.add(hit.target);
    const isUrl = /^https?:\/\//.test(hit.target);
    out.push({
      kind: isUrl ? 'url' : 'file',
      target: hit.target,
      label: isUrl ? hit.target.replace(/^https?:\/\//, '').split('/')[0]! : hit.target.split(/[\\/]/).pop() ?? hit.target,
      toolName: t.name,
      navigable: hit.navigable && !isUrl,
    });
  }
  return out;
}
