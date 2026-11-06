/**
 * 一维区间集合运算（用于 rule-sandbox 判定排序）。
 *
 * 判定条件都是「可拖参数 OP 常量」的形式，因此每条判定对应参数轴上的一个
 * 区间。区间只用于**比较判定的具体程度**（谁更窄谁更权威），实际命中判定
 * 仍由原始条件精确求值——这样严格不等号（`>` 与 `>=`）的边界不会被区间
 * 近似吃掉。端点一律按闭区间处理。
 */

export interface Interval {
  lo: number;
  hi: number;
}

/** 排序后互不重叠的区间集合。 */
export type IntervalSet = Interval[];

/** 合并排序区间：按 lo 升序，合并重叠或相邻的区间。 */
export function normalize(intervals: Interval[]): IntervalSet {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: IntervalSet = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current.lo <= last.hi) {
      if (current.hi > last.hi) last.hi = current.hi;
    } else {
      out.push({ ...current });
    }
  }
  return out;
}

/** v 是否落在集合内。 */
export function contains(set: IntervalSet, v: number): boolean {
  for (const interval of set) {
    if (v >= interval.lo && v <= interval.hi) return true;
  }
  return false;
}

/** 交集。 */
export function intersect(a: IntervalSet, b: IntervalSet): IntervalSet {
  const out: IntervalSet = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].lo, b[j].lo);
    const hi = Math.min(a[i].hi, b[j].hi);
    if (lo <= hi) out.push({ lo, hi });
    if (a[i].hi < b[j].hi) i += 1;
    else j += 1;
  }
  return normalize(out);
}

/** 并集。 */
export function union(a: IntervalSet, b: IntervalSet): IntervalSet {
  return normalize([...a, ...b]);
}

/**
 * a 是否包含于 b（b 更宽）。
 *
 * 逐区间比较：A 的每个区间都必须落在 B 的某个区间内。跨区间的拆分
 * （A 的一个区间横跨 B 的两个相邻区间）不视为包含——判定「谁更具体」
 * 时这是保守选择，宁可退回其他规则也不误判。
 */
export function isSubsetOf(a: IntervalSet, b: IntervalSet): boolean {
  if (a.length === 0) return true;
  for (const interval of a) {
    const covered = b.some((other) => interval.lo >= other.lo && interval.hi <= other.hi);
    if (!covered) return false;
  }
  return true;
}

/**
 * 集合的总长度。无界区间返回 Infinity。
 *
 * 用来在「互不包含」时比较具体程度：越窄的判定越具体。
 */
export function measure(set: IntervalSet): number {
  let total = 0;
  for (const interval of set) {
    if (!Number.isFinite(interval.lo) || !Number.isFinite(interval.hi)) return Infinity;
    total += interval.hi - interval.lo;
  }
  return total;
}
