import { useState } from 'react';
import type { ToolEvent } from '../hooks/useChat';

interface Props {
  tools: ToolEvent[];
  toolName: string;
}

/**
 * Collapsed group for consecutive same-type tool calls.
 * Claude Code style: minimal inline one-liners, no cards.
 * Collapsed: "▸ 86 个文件读取"
 * Expanded: list of "  ⎿ Read filename.md" lines
 */
export function ToolGroup({ tools, toolName }: Props) {
  const [expanded, setExpanded] = useState(false);

  const hasRunning = tools.some((t) => t.status === 'running');
  const hasError = tools.some((t) => t.isError);
  const statusIcon = hasRunning ? '' : hasError ? ' ✗' : '';

  const summary = groupSummary(toolName, tools.length);

  // Show all items when expanded (no truncation — user might want to see all)
  const items = expanded
    ? tools.map((t) => ({
        label: formatArg(t),
        status: t.status === 'running' ? 'running' : t.isError ? 'error' : 'done',
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

function groupSummary(toolName: string, count: number): string {
  const unit = groupUnit(toolName);
  return `${count} ${unit}`;
}

function groupUnit(toolName: string): string {
  switch (toolName) {
    case 'Read': return '个文件读取';
    case 'Write': return '个文件写入';
    case 'Edit': return '处修改';
    case 'Bash':
    case 'bash': return '个命令';
    case 'Glob': return '次文件搜索';
    case 'Grep': return '次内容搜索';
    case 'Agent': return '个子代理';
    case 'WebFetch': return '次网页抓取';
    case 'WebSearch': return '次网页搜索';
    default: return '次工具调用';
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
