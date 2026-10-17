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
  /** 展示 label：文件名（file）或 host（url）；同名文件加父目录消歧 */
  label: string;
  kind: 'file' | 'url';
  /** 被读取次数（跨轮累计）—— 排序依据 */
  count: number;
}

/** Grep 的 `path` 可能是 glob 模式（含 `*` `?` `[` `{`）—— 含元字符的不是文件。 */
const GLOB_META_CHARS = ['*', '?', '[', '{'];
function hasGlobMeta(p: string): boolean {
  return GLOB_META_CHARS.some((c) => p.includes(c));
}
/** 供 Grep 判「是不是文件」用：Grep 的 path 可能是目录，目录无扩展名。 */
const FILE_EXT_RE = /\.[A-Za-z0-9]+$/;

/**
 * 跨全部 assistant 消息聚合「读入」引用：按 kind+target 去重、累加 count。
 * 排除三类非「读过的文件」项：Glob pattern（navigable:false）、Grep 目录路径
 * （无扩展名）、库外/隐藏目录引用（classifyWritePath==='hidden'，预览必失败）。
 * 返回 count 降序，同 count 按首次出现顺序；文件同名经 disambiguateLabels 消歧。
 */
export function aggregateSessionSources(
  messages: ChatMessage[],
  vaultPath?: string,
): SessionSourceRef[] {
  const map = new Map<string, SessionSourceRef>();
  const firstSeen: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tools?.length) continue;
    for (const s of extractSources(m.tools)) {
      if (s.kind === 'file') {
        if (!s.navigable) continue; // Glob 工具的 pattern 不是文件
        if (hasGlobMeta(s.target)) continue; // Grep 的 glob 路径（含 * ? [ {）不是文件
        // Grep 的 path 可能是目录 → 要求带扩展名；Read/Bash(cat) 一定是文件（agent 不会 Read 目录），
        // 故不要求扩展名（否则 Makefile / LICENSE 这类真实文件会被静默丢掉）。
        if (s.toolName === 'Grep' && !FILE_EXT_RE.test(s.target)) continue;
        if (classifyWritePath(writeKey(s.target, vaultPath)) === 'hidden') continue; // 库外/隐藏
      }
      // 去重 key 用归一化路径：同一文件被先报绝对、后报相对是常见的 agent 上报行为
      // （与 workSteps.collectSessionWrites 同一教训——用原始串会渲染成多行、label 被消歧成路径）。
      const norm = s.kind === 'file' ? writeKey(s.target, vaultPath) : s.target;
      const key = `${s.kind}\u0000${norm}`;
      let e = map.get(key);
      if (!e) {
        e = { target: s.target, label: s.label, kind: s.kind, count: 0 };
        map.set(key, e);
        firstSeen.push(key);
      }
      e.count += 1;
    }
  }
  const all = [...map.values()];
  // 文件同名消歧：disambiguateLabels 就地改 label，但它读 `path` 字段——用代理对象转换。
  const fileRefs = all.filter((r) => r.kind === 'file');
  const proxies = fileRefs.map((r) => ({ path: r.target, label: r.label }));
  disambiguateLabels(proxies);
  fileRefs.forEach((r, i) => {
    r.label = proxies[i]!.label;
  });
  const rank = new Map(firstSeen.map((k, i) => [k, i]));
  all.sort(
    (a, b) =>
      b.count - a.count ||
      rank.get(`${a.kind}\u0000${a.target}`)! - rank.get(`${b.kind}\u0000${b.target}`)!,
  );
  return all;
}
