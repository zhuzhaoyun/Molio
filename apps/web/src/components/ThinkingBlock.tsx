import { useState } from 'react';

interface Props {
  content: string;
  streaming?: boolean;
}

export function ThinkingBlock({ content, streaming }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span>Thinking{streaming ? '...' : ''}</span>
      </div>
      {expanded && (
        <div className="thinking-content">{content}</div>
      )}
    </div>
  );
}
