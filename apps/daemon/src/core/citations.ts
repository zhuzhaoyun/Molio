/**
 * IM 出站「依据」清单（检索 P0 层 3 收尾）。桌面端的依据条已由 web
 * SourceChips + toolRefs.ts 承担（更丰富：URL/产物等），本模块只服务渠道文本
 * 出站（微信/飞书/企微）——从 tool_use 流提取「实际读过的文件」，拼成文本清单。
 *
 * 刻意不进持久化正文：桌面端已渲染依据条，落库正文再带一段是双重噪音，且
 * SaveToKb 存库也不该包含这段。调用方（ChannelDispatcher）只把它拼进 sendText。
 */

/** 只认读文件类命令；写/列目录不算「依据」。 */
const READ_COMMAND_RE = /^(?:cat|head|tail|less)(?:\s+-\S+)*\s+(\S+)/;

/**
 * 从一次 tool_use 提取被读文件路径；非读文件工具返回 null。
 * - Read → input.file_path
 * - Grep → input.path 仅当带扩展名（单文件）；目录 = 搜索动作，不算读
 * - Bash → cat/head/tail/less 的首个路径参数（与 web toolRefs 同规则）
 * - Glob/WebFetch/WebSearch/Write/Edit 等 → null
 * 归一化：\ → /，剥 ./ 前缀；http(s) URL 一律拒绝（非本地文件）。
 */
export function citationPathFromToolUse(name: string, input: unknown): string | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let raw: unknown = null;
  if (name === 'Read') {
    raw = o['file_path'];
  } else if (name === 'Grep') {
    const p = typeof o['path'] === 'string' ? o['path'] : null;
    return p && /\.[A-Za-z0-9]+$/.test(p) ? normalizeCitationPath(p) : null;
  } else if (name === 'Bash') {
    const cmd = typeof o['command'] === 'string' ? o['command'] : '';
    raw = READ_COMMAND_RE.exec(cmd.trim())?.[1] ?? null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  return normalizeCitationPath(raw);
}

function normalizeCitationPath(p: string): string | null {
  if (/^https?:\/\//i.test(p)) return null;
  const norm = p.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return norm || null;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

/**
 * 拼依据清单文本块；无引用（或去重后为空）返回 null。
 * 形如 "\n\n——\n依据：① 刑法分则.md ② 剪藏.md"。dedupe + 上限 max（默认 5），
 * 标号 ①②…⑩，超出用 n.。
 */
export function formatCitationBlock(paths: string[], max = 5): string | null {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    uniq.push(p);
    if (uniq.length >= max) break;
  }
  if (uniq.length === 0) return null;
  const items = uniq.map((p, i) => {
    const no = i < CIRCLED.length ? CIRCLED[i]! : `${i + 1}.`;
    const label = p.split(/[\\/]/).pop() ?? p;
    return `${no} ${label}`;
  });
  return `\n\n——\n依据：${items.join(' ')}`;
}
