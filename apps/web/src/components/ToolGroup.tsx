import { useState } from 'react';
import { useI18n } from '../i18n';
import type { ToolEvent } from '../hooks/useChat';

interface Props {
  tools: ToolEvent[];
  toolName: string;
}

/**
 * Collapsed group for consecutive same-type tool calls.
 * Claude Code style: minimal inline one-liners, no cards.
 * Collapsed: "▸ 86 file reads"
 * Expanded: list of "  ⎿ Read filename.md" lines
 */
export function ToolGroup({ tools, toolName }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const hasRunning = tools.some((t) => t.status === 'running');
  const hasError = tools.some((t) => t.isError);
  const statusIcon = hasRunning ? '' : hasError ? ' ✗' : '';

  const summary = groupSummary(toolName, tools.length, t);

  // Show all items when expanded (no truncation — user might want to see all)
  const items = expanded
    ? tools.map((tool) => ({
        label: formatArg(tool),
        status: tool.status === 'running' ? 'running' : tool.isError ? 'error' : 'done',
      }))
    : [];

  return (
    <div className="tool-group-inline">
      <div
        className="tool-group-row"
        onClick={() => setExpanded((e) => !e)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setExpanded((v) => !v)}
      >
        <span className="tool-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="tool-group-label">{summary}{statusIcon}</span>
      </div>
      {expanded && (
        <div className="tool-group-items">
          {items.map((item, i) => (
            <div key={i} className="tool-line">
              <span className="tool-line-arrow">⎿</span>
              <span className="tool-line-name">{toolName}</span>
              <span className="tool-line-arg">{item.label}</span>
              <span className={`tool-line-status ${item.status}`}>
                {item.status === 'running' ? '…' : item.status === 'error' ? '✗' : '✓'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type TranslationFn = (key: string) => string;

function groupSummary(toolName: string, count: number, t: TranslationFn): string {
  const unit = groupUnit(toolName, t);
  return `${count} ${unit}`;
}

function groupUnit(toolName: string, t: TranslationFn): string {
  switch (toolName) {
    case 'Read': return t('toolGroup.fileRead');
    case 'Write': return t('toolGroup.fileWrite');
    case 'Edit': return t('toolGroup.edit');
    case 'Bash':
    case 'bash': return t('toolGroup.command');
    case 'Glob': return t('toolGroup.fileSearch');
    case 'Grep': return t('toolGroup.contentSearch');
    case 'Agent': return t('toolGroup.agent');
    case 'WebFetch': return t('toolGroup.webFetch');
    case 'WebSearch': return t('toolGroup.webSearch');
    default: return t('toolGroup.default');
  }
}

function formatArg(tool: ToolEvent): string {
  const input = tool.input;
  if (typeof input === 'string') return truncate(input, 50);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj['file_path'] === 'string') {
      const path = obj['file_path'] as string;
      const parts = path.split(/[\\/]/);
      // Show last 2 segments for context
      return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : path;
    }
    if (typeof obj['command'] === 'string') return truncate(obj['command'] as string, 50);
    if (typeof obj['pattern'] === 'string') return obj['pattern'] as string;
    if (typeof obj['query'] === 'string') return truncate(obj['query'] as string, 50);
    if (typeof obj['url'] === 'string') return truncate(obj['url'] as string, 50);
    if (typeof obj['description'] === 'string') return truncate(obj['description'] as string, 50);
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
