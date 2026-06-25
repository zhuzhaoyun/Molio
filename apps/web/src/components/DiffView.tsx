// apps/web/src/components/DiffView.tsx
import { useMemo } from 'react';
import { useI18n } from '../i18n';
import './DiffView.css';

interface Props {
  oldStr: string;
  newStr: string;
}

interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
}

/**
 * Line-based diff using LCS (longest common subsequence). Handles duplicate
 * lines and interleaved changes correctly — the previous includes()-based
 * heuristic marked all duplicate lines as context and dumped deletions before
 * additions, producing misleading diffs for replacements.
 */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  // Identical (including both empty) → no diff lines; the component shows
  // the "no changes" message instead of rendering all context lines.
  if (oldStr === newStr) return [];

  // Write (create): no old content → all additions.
  if (!oldStr) {
    return newStr.split('\n').map((line) => ({ type: 'add' as const, content: line }));
  }
  // Deletion: no new content → all deletions.
  if (!newStr) {
    return oldStr.split('\n').map((line) => ({ type: 'del' as const, content: line }));
  }

  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const m = a.length;
  const n = b.length;

  // Build LCS length table (bottom-up). O(m*n) memory — fine for short
  // AI-generated edits; fall back to the simple heuristic for very large
  // inputs to avoid pathological memory use.
  if (m * n > 2_000_000) {
    return simpleDiff(a, b);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ type: 'ctx', content: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', content: a[i] });
      i++;
    } else {
      result.push({ type: 'add', content: b[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ type: 'del', content: a[i] });
    i++;
  }
  while (j < n) {
    result.push({ type: 'add', content: b[j] });
    j++;
  }
  return result;
}

/** Fallback for very large inputs — deletion-then-addition (no interleaving). */
function simpleDiff(a: string[], b: string[]): DiffLine[] {
  const bset = new Set(b);
  const result: DiffLine[] = [];
  for (const line of a) {
    if (!bset.has(line)) result.push({ type: 'del', content: line });
    else result.push({ type: 'ctx', content: line });
  }
  const aset = new Set(a);
  for (const line of b) {
    if (!aset.has(line)) result.push({ type: 'add', content: line });
  }
  return result;
}

export function DiffView({ oldStr, newStr }: Props) {
  const { t } = useI18n();
  const lines = useMemo(() => computeDiff(oldStr, newStr), [oldStr, newStr]);

  if (lines.length === 0) {
    return <div className="diff-view"><div className="diff-line diff-line-ctx">{t('diff.noChanges')}</div></div>;
  }

  const prefix = (type: DiffLine['type']) => (type === 'add' ? '+' : type === 'del' ? '-' : ' ');
  return (
    <div className="diff-view" data-testid="diff-view">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`diff-line diff-line-${line.type}`}
        >
          {prefix(line.type)} {line.content}
        </div>
      ))}
    </div>
  );
}
