// apps/web/src/utils/messageRail.ts
// 消息导航 rail 的纯函数层（docs/2026-11-16-message-rail-design.md §4）。
// 刻度 = 一次提问（问答对）：user 开对、其后 assistant/error 并入、前导孤儿不入对。
// 几何（tops/heights）由调用方从 DOM 量出缓存后传入——本层不碰 DOM。
export const RAIL_TICK_IDEAL = 18;
export const RAIL_TICK_MIN = 4;
export const RAIL_TICK_GAP = 6;
export const RAIL_MIN_PAIRS = 3;
export const RAIL_OVERFLOW_MIN = 40;

export interface RailPair {
  /** 该问答对首条消息（user）在 messages 数组的下标 */
  userMsgIndex: number;
  /** 该对末条消息下标（含 assistant/error，直到下一条 user 前） */
  lastMsgIndex: number;
  /** 提问预览文本（已清洗） */
  preview: string;
}

/** 逐条扫描消息序列，按 user 消息切分成问答对。前导非 user 消息不属于任何 pair。 */
export function buildRailPairs(
  messages: ReadonlyArray<{ role: string; content: string }>,
): RailPair[] {
  const pairs: RailPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== 'user') continue;
    let last = i;
    for (let j = i + 1; j < messages.length && messages[j]!.role !== 'user'; j++) {
      last = j;
    }
    pairs.push({ userMsgIndex: i, lastMsgIndex: last, preview: previewText(messages[i]!.content) });
  }
  return pairs;
}

/**
 * 活跃刻度：第一个与视口 [scrollTop, viewportBottom) 相交的对。
 * 视口低于全部内容（贴底 / overscroll / 对间空隙落到底）→ 末对；空 → -1。
 * 线性扫描：提问数 ≤ 百级，缓存几何上做算术足够便宜。
 */
export function findActivePair(
  pairs: RailPair[],
  tops: number[],
  heights: number[],
  scrollTop: number,
  viewportBottom: number,
): number {
  if (pairs.length === 0) return -1;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    const top = tops[p.userMsgIndex];
    const bottom = tops[p.lastMsgIndex] + heights[p.lastMsgIndex];
    if (top === undefined || bottom === undefined) continue;
    if (bottom > scrollTop && top < viewportBottom) return i;
  }
  return pairs.length - 1;
}

/**
 * 刻度布局：宽裕用 IDEAL/GAP；拥挤时等差压缩，保底 MIN；
 * 连 MIN 都塞不下时 tick 钉在 MIN、gap 吃余量（rail 自身永不滚动）。
 */
export function railTickLayout(count: number, availableHeight: number): { tick: number; gap: number } {
  if (count <= 0) return { tick: 0, gap: 0 };
  const fit = Math.floor((availableHeight - (count - 1) * RAIL_TICK_GAP) / count);
  const tick = Math.min(RAIL_TICK_IDEAL, Math.max(RAIL_TICK_MIN, fit));
  if (tick > fit) {
    // floor 值低于 MIN：MIN 也装不下，gap 压缩兜底
    const gap = count > 1
      ? Math.max(0, (availableHeight - RAIL_TICK_MIN * count) / (count - 1))
      : 0;
    return { tick: RAIL_TICK_MIN, gap };
  }
  return { tick, gap: RAIL_TICK_GAP };
}

/** 可见双阈值：≥3 次提问 且 内容溢出 >40px（隐藏容器 clientHeight≈0 时恒不可见）。 */
export function isRailVisible(
  pairCount: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return pairCount >= RAIL_MIN_PAIRS && scrollHeight - clientHeight > RAIL_OVERFLOW_MIN;
}

/** 提问预览清洗：剥图片/链接 markdown、折叠空白、超长截断加省略号。 */
export function previewText(content: string, maxChars = 80): string {
  let s = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // 图片 markdown（整行/内联）
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接取文字
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + '…';
  return s;
}
