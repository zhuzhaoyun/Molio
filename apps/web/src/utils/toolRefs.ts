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

/** extractSources 的口径开关。 */
export interface ExtractSourcesOptions {
  /**
   * false = 不按 target 去重，同一文件被读多次会产出多条（用于统计「引用次数」）。
   * true（默认）= 单条消息内按 target 去重 —— 消息内联引用标签的 chip 口径。
   *
   * 另：dedupe=false 时不再受 MAX_URL_CHIPS 限制（那个上限是给 chip 渲染防爆炸用的，
   * 计数场景不渲染 chip，截断会让次数失真）。
   */
  dedupe?: boolean;
}

/**
 * 从一条 assistant 消息的 tools 抽取「引用」：Read/Grep/Bash(cat) → 文件，WebFetch → URL，
 * Glob → 搜索 pattern（不可跳转），WebSearch → result 文本内每条 URL 一个 chip。
 * 仅保留完成（done）的工具 —— running 中的等完成后再显示，
 * error（tool_result isError）的不当作引用。
 */
export function extractSources(tools: ToolEvent[], opts: ExtractSourcesOptions = {}): SourceRef[] {
  const dedupe = opts.dedupe !== false;
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
        if (dedupe) {
          if (urlChips >= MAX_URL_CHIPS || seen.has(url)) continue;
          seen.add(url); urlChips++;
        }
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
    if (dedupe) {
      if (seen.has(hit.target)) continue;
      if (isUrl && urlChips >= MAX_URL_CHIPS) continue;
      seen.add(hit.target);
      if (isUrl) urlChips++;
    }
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

/**
 * 把 agent 上报的路径归一化为去重 key：Windows 分隔符统一、剥 ./ 前缀、
 * vault 内绝对路径还原为相对（与 daemon toVaultRelativePath 同一语义，轻量版）。
 * Write 工具的上报形态不稳定（同文件可能被先报相对后报绝对），不去重会重复列出。
 * 归一化后仍是绝对路径 = vault 前缀没命中，即写在库外（见 classifyWritePath）。
 */
export function writeKey(rawPath: string, vaultPath?: string): string {
  let p = rawPath.replace(/\\/g, '/');
  p = p.replace(/^\.\/+/, '');
  if (vaultPath) {
    const vp = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(`${vp}/`)) p = p.slice(vp.length + 1);
    else if (p === vp) p = '';
  }
  return p;
}

/** 写入路径的三层归类（产出面板分流 + 横幅过滤的真值源）。 */
export type WriteLayer = 'product' | 'other' | 'hidden';

/** Markdown 文档扩展名 —— 只有这类才被当作「用户要的产出」。 */
const MARKDOWN_RE = /\.(mdown|markdown|md)$/i;

/**
 * 「登记 / 缓存」类元文件的 basename（小写）—— 它们是 wiki 技能每次操作都重写一遍的
 * 骨架文件，用户从不点开，不算产出：
 *   `INDEX.md`（根与各级目录索引）、`log.md`（操作日志）、`hot.md`（近期上下文缓存）。
 *
 * 判据与 daemon `routes/graph.ts` 的 GRAPH_EXCLUDED_BASENAMES（index/log）同源 ——
 * 图谱早就不把它们当节点；`wiki-build/scripts/sweep.mjs`、`checkoff.mjs` 与
 * `wiki-lint` 统计「页面」时同样排除这三个名字。只按 basename 判定、不限定目录：
 * 与图谱保持一致，且「哪个目录算 wiki」本就是猜的。
 */
const META_BASENAMES = new Set(['index.md', 'log.md', 'hot.md']);

/**
 * 归类一条写入路径（输入为 writeKey 归一化后的形态）：
 * - `hidden`  —— 库外写入（仍是绝对路径 / `~` / 含 `..`）或落在点开头目录：一律不出现。
 *   库外写入的预览与「在资源管理器中显示」都必然失败（daemon 只认 vault 内路径），
 *   混进面板等于给用户两个坏按钮。
 * - `other`   —— 库内非文档（`.py`/`.tsv` 等）或登记元文件（`INDEX.md`/`log.md`/`hot.md`）：
 *   折叠进「其他写入」。
 * - `product` —— 库内文档：面板主列表。
 */
export function classifyWritePath(key: string): WriteLayer {
  const p = key.replace(/\\/g, '/');
  // 归一化后仍是绝对路径 / 家目录 / 盘符 → vault 前缀没命中，说明写在库外
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:\//.test(p)) return 'hidden';
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return 'hidden';
  // 任一段以 . 开头（.molio / .claude / .drafts / .hidden.md）都是隐藏项
  if (segments.some((s) => s.length > 1 && s.startsWith('.'))) return 'hidden';
  const base = segments[segments.length - 1] ?? '';
  if (META_BASENAMES.has(base.toLowerCase())) return 'other';
  return MARKDOWN_RE.test(base) ? 'product' : 'other';
}

export type WriteKind = 'create' | 'update';

export interface WriteRef {
  path: string;
  label: string;
  toolName: string;
  /** 产出溯源：产生该写入的工具事件 id（会话内定位回跳用） */
  toolId: string;
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
 * 从一条 assistant 消息的 tools 抽取「写入」：Write/Edit/EditFile/MultiEdit/Append/
 * AppendFile，按 path 去重。仅保留完成（done）的工具 —— error（tool_result isError）
 * 的不当作已写入产物，避免 banner 标题「已完成，产出已写入知识库」在写入失败时误导用户。
 *
 * **不含 kind**：「新建还是更新」取决于该路径在会话里出现过没有（见 workSteps 的
 * collectSessionWrites），单条消息的 tools 里没有这个信息 —— 早先按工具名判
 * （Write=新建 / Edit=更新）会把覆写既有文件也标成新建。
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
      path,
      label: path.split(/[\\/]/).pop() ?? path,
      toolName: t.name,
      toolId: t.id,
    });
  }
  return out;
}
