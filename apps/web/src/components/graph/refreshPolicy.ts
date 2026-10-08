/**
 * 图谱自动刷新的策略（纯函数，node:test 覆盖）。
 *
 * 背景：daemon 的 VaultWatcher 对**任何**文件变化都推 `tree-changed`，比图谱的
 * 实际依赖（.md 文件集合 + [[wikilink]]）宽得多——往 raw/ 拷个 PDF、改个错别字
 * 同样会推。而每次重建图谱都要重跑一遍力导向仿真（实测 1445 节点 ≈ 2.9s CPU，
 * 固定 300 ticks），所以「信号响了就无条件重建」不可接受。这两个函数分别回答：
 *   1. 数据真的变了吗？（graphFingerprint —— 没变就不重建）
 *   2. 多等一会儿能把多波信号合并掉吗？（refreshDebounceMs —— 按规模分档）
 */

import type { GraphData } from '@molio/contracts';

/** 尾随防抖的基础延迟（小图）。 */
export const REFRESH_DEBOUNCE_BASE_MS = 400;
/** 中图延迟：重排代价开始可观，值得多等一会儿合并写入波次。 */
export const REFRESH_DEBOUNCE_MEDIUM_MS = 800;
/** 大图延迟：一次重排要数秒 CPU，宁可让用户多等。 */
export const REFRESH_DEBOUNCE_LARGE_MS = 1500;

const MEDIUM_NODE_THRESHOLD = 300;
const LARGE_NODE_THRESHOLD = 800;

/**
 * 按图规模选择尾随防抖延迟——延迟随节点数单调不减。
 *
 * 阈值取自本机实测（apps/web 的 d3-force 同参基准）：
 * 300 节点以内重排无感（<200ms CPU），800 节点以上单次重排接近或超过 1s CPU。
 */
export function refreshDebounceMs(nodeCount: number): number {
  if (nodeCount > LARGE_NODE_THRESHOLD) return REFRESH_DEBOUNCE_LARGE_MS;
  if (nodeCount > MEDIUM_NODE_THRESHOLD) return REFRESH_DEBOUNCE_MEDIUM_MS;
  return REFRESH_DEBOUNCE_BASE_MS;
}

/**
 * 把一份图谱数据压成可比对的指纹字符串——内容相同则指纹相同。
 *
 * 用 netstring 格式（`<长度>:<内容>`）逐字段写出：长度前缀让拼接结果**唯一可解码**，
 * 所以键名里含 `|`、换行甚至任何分隔符都不会串味（`a|b` 与 `a` + `b` 必然不同）。
 *
 * 故意不做哈希：指纹只用来与本地上一次的指纹做 `===` 比对，保留原文就没有碰撞风险
 * （碰撞会让用户看到过期图谱）。大库下指纹约数百 KB，相比一次 2.9s 的重排可以忽略。
 *
 * 顺序无关：daemon 的 scanTree 依赖 readdir 返回顺序，往根目录丢一个无关文件就可能让
 * 「同一批节点」换序返回；若指纹顺序敏感，这类噪音会被误判成「数据变了」而触发一次
 * 无谓的全量重排。所以节点/边/死链都先按自身序列化排序再拼接（排序是多重集上的双射，
 * 不引入歧义）。代价是大库下一次排序，相对于它避免的重排可以忽略。
 */
export function graphFingerprint(data: GraphData): string {
  const parts: string[] = [];
  const put = (s: string) => parts.push(`${s.length}:${s}`);
  /** 逐字段 netstring 拼接——排序与写出都以整个实体为单位，字段间不会串味。 */
  const join = (fields: string[]) => fields.map((f) => `${f.length}:${f}`).join('');

  put('v1');

  const nodes = data.nodes
    .map((n) => join([n.key, n.label, n.path, String(n.linkCount), n.nodeType ?? '', n.deadLink ? '1' : '0']))
    .sort();
  put(String(nodes.length));
  for (const n of nodes) put(n);

  const edges = data.edges.map((e) => join([e.source, e.target])).sort();
  put(String(edges.length));
  for (const e of edges) put(e);

  const focus = (data.focusNodes ?? []).slice().sort();
  put(String(focus.length));
  for (const f of focus) put(f);

  // 死链只进统计弹层，但也要纳入——否则「死链数变了」会被判成无变化
  const dead = (data.deadLinks ?? []).map((d) => join([d.sourceFile, d.targetName])).sort();
  put(String(dead.length));
  for (const d of dead) put(d);

  return parts.join('');
}
