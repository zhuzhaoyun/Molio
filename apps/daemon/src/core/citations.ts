/**
 * IM 出站「依据」清单（检索 P0 层 3 收尾）。桌面端的依据条已由 web
 * SourceChips + toolRefs.ts 承担（更丰富：URL/产物等），本模块只服务渠道文本
 * 出站（微信/飞书/企微）——从 tool_use 流提取「实际读过的文件」，拼成文本清单。
 *
 * 刻意不进持久化正文：桌面端已渲染依据条，落库正文再带一段是双重噪音，且
 * SaveToKb 存库也不该包含这段。调用方（ChannelDispatcher）只把它拼进 sendText。
 */

/**
 * 「读文件」命令两族（E1 对账实验后从单条正则升级，2026-10）：
 * - 整条命令就是读：cat/head/tail/less 的非 flag 参数都是被读文件
 * - 带脚本/模式的读取：grep/rg/sed/awk 的文件操作数（跳过首个位置参数 = 模式/脚本；
 *   要求带扩展名，目录 = 搜索动作不算读——与 Grep 工具同语义）
 *
 * ⚠️ 与 apps/web/src/utils/toolRefs.ts 的 bashReadPaths 是镜像实现——改一处必须同步另一处。
 */
const CAT_LIKE = new Set(['cat', 'head', 'tail', 'less']);
const SCRIPT_READERS = new Set(['grep', 'rg', 'sed', 'awk']);

const HAS_EXT_RE = /\.[A-Za-z0-9]{1,5}$/;

/** 极简分词：按空白切，剥成对引号（够用于路径提取，不解释 shell 语义）。 */
function tokenize(segment: string): string[] {
  const m = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return m.map((t) => (t.length >= 2 && /^["'].*["']$/.test(t) ? t.slice(1, -1) : t));
}

function normalizeToken(t: string): string {
  return t.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/**
 * 从一条 Bash 命令提取「被读的文件」清单（0..n 条）。
 * 覆盖 E1 实测漏记的四类写法：复合命令（&&/;/|）里非开头的 cat、一条命令读多个
 * 文件、cd 后的相对路径、for 循环清单、sed/grep 直读文件。
 * 刻意不做的事：不跟踪 cd 拼 cwd（跨调用的 cwd 是会话态，面板侧拿不到稳定
 * 语义）；不解释 $(...) 与变量展开（$f 无法解析，靠 for 清单兜住真实文件名）。
 * 重定向目标（> f / >> f / 2> f）是写入不是读取，先剥掉。
 */
export function bashReadPaths(command: string): string[] {
  const out: string[] = [];
  if (!command) return out;
  const multiline = command.replace(/\r?\n/g, '; ');
  // 剥重定向目标：n>&、>>、2> 等后跟的第一个 token 是写入去向
  const cleaned = multiline.replace(/(?:\d)?&?>{1,2}\s*\S+/g, ' ');
  for (const segment of cleaned.split(/&&|\|\||;|\|/)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const head = tokens[0]!;
    const word = (head.split('/').pop() ?? head).toLowerCase();
    if (CAT_LIKE.has(word)) {
      for (const t of tokens.slice(1)) {
        if (t.startsWith('-') || t.startsWith('+') || t.startsWith('$')) continue;
        // flag 的取值（head -n 20 里的 20）：裸数字/数字+单位不算路径
        if (/^[+-]?\d+[a-zA-Z]?$/.test(t)) continue;
        out.push(normalizeToken(t));
      }
    } else if (SCRIPT_READERS.has(word)) {
      const positionals = tokens.slice(1).filter((t) => !t.startsWith('-'));
      // 首个位置参数是模式/脚本本身，跳过；其余带扩展名的才算文件操作数
      for (const t of positionals.slice(1)) {
        if (HAS_EXT_RE.test(t)) out.push(normalizeToken(t));
      }
    } else if (word === 'for') {
      // for f in a.md b.md; do cat $f; done —— 清单里的真实文件名
      const inIdx = tokens.indexOf('in');
      if (inIdx > 0) {
        for (const t of tokens.slice(inIdx + 1)) {
          if (HAS_EXT_RE.test(t)) out.push(normalizeToken(t));
        }
      }
    }
  }
  return out;
}

/**
 * 从一次 tool_use 提取被读文件路径**清单**；非读文件工具返回空数组。
 * - Read → input.file_path
 * - Grep → input.path 仅当带扩展名（单文件）；目录 = 搜索动作，不算读
 * - Bash → bashReadPaths（命令级解析，见上）
 * - Glob/WebFetch/WebSearch/Write/Edit 等 → []
 * 归一化：\ → /，剥 ./ 前缀；http(s) URL 一律拒绝（非本地文件）。
 */
export function citationPathsFromToolUse(name: string, input: unknown): string[] {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (name === 'Read') {
    const raw = o['file_path'];
    if (typeof raw !== 'string' || !raw) return [];
    const p = normalizeCitationPath(raw);
    return p ? [p] : [];
  }
  if (name === 'Grep') {
    const p = typeof o['path'] === 'string' ? o['path'] : null;
    if (!p || !/\.[A-Za-z0-9]+$/.test(p)) return [];
    const norm = normalizeCitationPath(p);
    return norm ? [norm] : [];
  }
  if (name === 'Bash') {
    const cmd = typeof o['command'] === 'string' ? o['command'] : '';
    return bashReadPaths(cmd).filter((p) => !/^https?:\/\//i.test(p));
  }
  return [];
}

/**
 * 单数版（旧接口）：取清单第一条。IM 渠道新代码请用 citationPathsFromToolUse。
 */
export function citationPathFromToolUse(name: string, input: unknown): string | null {
  return citationPathsFromToolUse(name, input)[0] ?? null;
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
