import { useEffect, useRef } from 'react';
import type { AgentEvent } from '@kge/contracts';

interface Props {
  events: AgentEvent[];
  textContent: string;
}

export function EventStream({ events, textContent }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  const toolEvents = events.filter(
    (e) => e.type === 'tool_use' || e.type === 'tool_result'
  );
  const statusEvents = events.filter(
    (e) => e.type === 'status' || e.type === 'usage' || e.type === 'error'
  );

  return (
    <div className="event-stream">
      {/* Status events */}
      {statusEvents.map((e, i) => (
        <div key={`status-${i}`} className={`event-line event-${e.type}`}>
          {e.type === 'status' && (
            <span className="event-label">{e.label}{e.model ? ` (${e.model})` : ''}</span>
          )}
          {e.type === 'usage' && (
            <span className="event-label">
              Tokens: {e.usage?.input_tokens ?? 0} in / {e.usage?.output_tokens ?? 0} out
              {e.costUsd ? ` · $${e.costUsd.toFixed(4)}` : ''}
            </span>
          )}
          {e.type === 'error' && (
            <span className="event-error">{e.message}</span>
          )}
        </div>
      ))}

      {/* Text content */}
      {textContent && (
        <div className="event-text">
          <pre>{textContent}</pre>
        </div>
      )}

      {/* Tool events */}
      {toolEvents.map((e, i) => (
        <div key={`tool-${i}`} className={`event-line event-${e.type}`}>
          {e.type === 'tool_use' && (
            <>
              <span className="tool-icon">&gt;</span>
              <span className="tool-name">{e.name}</span>
              <span className="tool-input">{formatToolInput(e.input)}</span>
            </>
          )}
          {e.type === 'tool_result' && (
            <>
              <span className={`tool-icon ${e.isError ? 'error' : ''}`}>
                {e.isError ? '✗' : '✓'}
              </span>
              <span className="tool-result-content">{truncate(e.content, 200)}</span>
            </>
          )}
        </div>
      ))}

      <div ref={bottomRef} />
    </div>
  );
}

function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj['command'] === 'string') return obj['command'] as string;
    return JSON.stringify(input).slice(0, 120);
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
