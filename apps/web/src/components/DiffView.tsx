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
 * Minimal line-based diff: old lines removed, new lines added.
 * Uses a simple LCS-free heuristic — adequate for short AI-generated edits.
 */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  if (!oldStr && !newStr) return [];

  // Handle Write (create) case: no old content → all additions
  if (!oldStr) {
    return newStr.split('\n').map((line) => ({ type: 'add' as const, content: line }));
  }

  // Handle deletion case: no new content → all deletions
  if (!newStr) {
    return oldStr.split('\n').map((line) => ({ type: 'del' as const, content: line }));
  }

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  // Simple approach: removed old lines, then added new lines.
  // For a proper diff we'd use LCS, but for AI tool_use edits this is enough.
  for (const line of oldLines) {
    if (!newLines.includes(line)) {
      result.push({ type: 'del', content: line });
    } else {
      result.push({ type: 'ctx', content: line });
    }
  }
  for (const line of newLines) {
    if (!oldLines.includes(line)) {
      result.push({ type: 'add', content: line });
    }
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
