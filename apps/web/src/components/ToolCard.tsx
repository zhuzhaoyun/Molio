import type { ToolEvent } from '../hooks/useChat';

interface Props {
  tool: ToolEvent;
}

export function ToolCard({ tool }: Props) {
  const detail = formatToolInput(tool.input);
  const statusClass = tool.status === 'running' ? 'running' : tool.isError ? 'error' : 'done';
  const statusLabel = tool.status === 'running' ? '...' : tool.isError ? '✗' : '✓';

  return (
    <div className="tool-card">
      <div className="tool-card-header">
        <span className="tool-card-icon">›</span>
        <span className="tool-card-name">{tool.name}</span>
        {detail && <span className="tool-card-detail">{detail}</span>}
        <span className={`tool-card-status ${statusClass}`}>{statusLabel}</span>
      </div>
      {tool.result && (
        <div className={`tool-card-body ${tool.isError ? 'error' : ''}`}>
          {tool.result}
        </div>
      )}
    </div>
  );
}

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 80);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj['command'] === 'string') return truncate(obj['command'] as string, 80);
    if (typeof obj['file_path'] === 'string') return obj['file_path'] as string;
    if (typeof obj['description'] === 'string') return truncate(obj['description'] as string, 80);
    if (typeof obj['url'] === 'string') return obj['url'] as string;
    return truncate(JSON.stringify(input), 80);
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
