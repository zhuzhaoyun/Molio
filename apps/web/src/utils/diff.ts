// apps/web/src/utils/diff.ts
// 行级空白 diff —— 产出面板「变更」tab 用的伪 diff 引擎。
// 纯函数，零依赖，便于单测。仅做行级增删，不做词级/字符级（280px dock 里
// 词级过于细碎，行级已足够回答「它动了哪些地方」）。
// Phase 2 之前只覆盖 Edit/MultiEdit 的 old_string→new_string；Write 覆盖整
// 文件替换缺旧内容，由调用方标注占位。

export interface DiffLine {
  type: 'add' | 'del' | 'same';
  text: string;
}

/**
 * 对两段文本做行级 LCS diff。
 * @param oldText 改动前（Edit 的 old_string）
 * @param newText 改动后（Edit 的 new_string）
 * @returns 按出现顺序排列的行序列；只含 add/del 行（same 行剔除，避免刷屏），
 *          靠 type 区分增删。
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: DiffLine[] = [];

  // LCS DP 表：lcs[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // 回溯生成 diff
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });

  return out;
}

/** 是否构成「有效」改动：至少有一条增或删（old/new 逐字相同则无变更可视）。 */
export function hasRealChange(oldText: string, newText: string): boolean {
  const d = lineDiff(oldText, newText);
  return d.some((l) => l.type !== 'same');
}

function splitLines(text: string): string[] {
  // 统一换行并去尾部空行，让「只有尾随换行差异」不误报为增删
  return text.replace(/\r\n/g, '\n').split('\n');
}
