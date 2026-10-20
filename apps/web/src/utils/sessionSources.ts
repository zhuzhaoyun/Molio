/**
 * 会话级「引用」聚合（读入面）—— dock『引用』tab 的数据源。
 * 与 workSteps.ts 的「产出」（写入面）成对：写入来自 Write/Edit，引用来自
 * Read/Grep/Bash(cat)/WebFetch/WebSearch（复用 extractSources 的单条口径，此处跨轮合并）。
 *
 * 历史：本面板 2026-08 有过「来源」分区，因与写入上下同屏（「混入产出」）被移除
 * （commit ac179411）。此处以独立 tab 呈现，规避该理由。
 */
import type { ChatMessage } from '../hooks/useChatCore.ts';
import { extractSources, classifyWritePath, writeKey } from './toolRefs.ts';
import { disambiguateLabels } from './workSteps.ts';

export interface SessionSourceRef {
  /** vault 相对路径（file）或完整 URL —— 作 key / 展示 / 预览 */
  target: string;
  /** 展示 label：文件名（file）或 host（url）；同名时加父目录消歧 */
  label: string;
  kind: 'file' | 'url';
  /** 被引用次数（跨轮累计）—— 排序依据 */
  count: number;
}

/** 一次会话的引用汇总。 */
export interface SessionSources {
  /** 面板展示的引用：库内文件 + 网页链接 */
  refs: SessionSourceRef[];
  /**
   * **被过滤掉、面板不展示**的引用（库外文件 / 隐藏目录 / 检索目录 / glob pattern）。
   *
   * 为什么必须单独回传：消息内联的引用标签（SourceChips）**照单全收**这些项，
   * 而面板按「点得开才算数」过滤掉了它们 —— 于是同一屏里用户看到的标签数
   * 比面板列出的多，少的那些会让人以为面板漏了。面板必须自己说明少了什么，
   * 否则这个面板的「诚实」是假的。
   */
  omitted: SessionSourceRef[];
}

/** Grep 的 `path` 可能是 glob 模式（含 `*` `?` `[` `{`）—— 含元字符的不是文件。 */
const GLOB_META_CHARS = ['*', '?', '[', '{'];
function hasGlobMeta(p: string): boolean {
  return GLOB_META_CHARS.some((c) => p.includes(c));
}
/** 供 Grep 判「是不是文件」用：Grep 的 path 可能是目录，目录无扩展名。 */
const FILE_EXT_RE = /\.[A-Za-z0-9]+$/;

/**
 * 判一个文件类来源「为什么进不了面板」，返回过滤原因；能展示则返回 null。
 * 四个原因与消息内联标签的差异一一对应（那里这些项照单全收）。
 */
function omitReason(
  toolName: string,
  target: string,
  navigable: boolean,
  vaultPath?: string,
): 'glob-pattern' | 'search-dir' | 'outside' | null {
  if (!navigable) return 'glob-pattern';          // Glob 工具的 pattern 不是文件
  if (hasGlobMeta(target)) return 'glob-pattern';  // Grep 的 glob 路径（含 * ? [ {）不是文件
  // Grep 的 path 可能是目录 → 要求带扩展名；Read/Bash(cat) 一定是文件（agent 不会 Read 目录），
  // 故不要求扩展名（否则 Makefile / LICENSE 这类真实文件会被静默丢掉）。
  if (toolName === 'Grep' && !FILE_EXT_RE.test(target)) return 'search-dir';
  // 库外路径 / 隐藏目录（.molio、.claude）：预览必然失败，不进面板
  if (classifyWritePath(writeKey(target, vaultPath)) === 'hidden') return 'outside';
  return null;
}

/** 归一化去重 key：同类同 target 合并（绝对/./相对/相对三种上报形态归一）。 */
function refKey(kind: 'file' | 'url', target: string, vaultPath?: string): string {
  const norm = kind === 'file' ? writeKey(target, vaultPath) : target;
  return `${kind}\u0000${norm}`;
}

/** 累加计数并记住首次出现顺序。 */
function bump(
  map: Map<string, SessionSourceRef>,
  order: string[],
  key: string,
  target: string,
  label: string,
  kind: 'file' | 'url',
): void {
  let e = map.get(key);
  if (!e) {
    e = { target, label, kind, count: 0 };
    map.set(key, e);
    order.push(key);
  }
  e.count += 1;
}

/**
 * 跨全部 assistant 消息聚合「读入」引用：按 kind+target 去重、累加 count。
 *
 * 计数口径 = **引用次数**（同一轮里读同一文件 3 次算 3），不是「有几条消息引用过」——
 * 后者会让面板上一排 badge 都是 1，看着像坏掉的数字（extractSources 的 chip 口径
 * 在单条消息内就按 target 去重了，故此处按出现次数取，dedupe:false）。
 *
 * 返回 { refs, omitted }：refs 是展示清单，omitted 是被过滤掉的引用
 * （库外文件 / 隐藏目录 / 检索目录 / glob pattern）—— 面板要据此说明「还有 N 条未展示」。
 */
export function aggregateSessionSources(
  messages: ChatMessage[],
  vaultPath?: string,
): SessionSources {
  const map = new Map<string, SessionSourceRef>();
  const order: string[] = [];
  const omittedMap = new Map<string, SessionSourceRef>();
  const omittedOrder: string[] = [];

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tools?.length) continue;
    for (const s of extractSources(m.tools, { dedupe: false })) {
      if (s.kind === 'file') {
        const reason = omitReason(s.toolName, s.target, s.navigable, vaultPath);
        if (reason) {
          bump(omittedMap, omittedOrder, refKey('file', s.target, vaultPath), s.target, s.label, 'file');
          continue;
        }
      }
      bump(map, order, refKey(s.kind, s.target, vaultPath), s.target, s.label, s.kind);
    }
  }

  const refs = sortRefs([...map.values()], order, vaultPath);
  const omitted = sortRefs([...omittedMap.values()], omittedOrder, vaultPath);
  return { refs, omitted };
}

/** count 降序，同 count 按首次出现顺序；同名文件加父目录消歧。 */
function sortRefs(refs: SessionSourceRef[], order: string[], vaultPath?: string): SessionSourceRef[] {
  const files = refs.filter((r) => r.kind === 'file');
  // disambiguateLabels 就地改 label，但它读 `path` 字段——用代理对象转换。
  const proxies = files.map((r) => ({ path: r.target, label: r.label }));
  disambiguateLabels(proxies);
  files.forEach((r, i) => {
    r.label = proxies[i]!.label;
  });
  const rank = new Map(order.map((k, i) => [k, i]));
  refs.sort(
    (a, b) =>
      b.count - a.count ||
      (rank.get(refKey(a.kind, a.target, vaultPath)) ?? 0) -
        (rank.get(refKey(b.kind, b.target, vaultPath)) ?? 0),
  );
  return refs;
}
