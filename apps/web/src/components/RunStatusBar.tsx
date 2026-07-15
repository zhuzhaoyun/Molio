// apps/web/src/components/RunStatusBar.tsx
import { useRunPhase } from '../hooks/useRunPhase';
import type { ChatMessage } from '../hooks/useChatCore';

interface Props {
  messages: ChatMessage[];
  isRunning: boolean;
}

export function RunStatusBar({ messages, isRunning }: Props) {
  const { phase, elapsedMs } = useRunPhase(messages, isRunning);

  if (phase.type === 'idle') return null;

  const elapsedSec = Math.floor(elapsedMs / 1000);

  let label: string;
  let dataPhase: string;

  switch (phase.type) {
    case 'thinking':
      label = `思考中... · ${elapsedSec}s`;
      dataPhase = 'thinking';
      break;
    case 'tool':
      label = `${phase.toolName} · ${elapsedSec}s`;
      dataPhase = 'tool';
      break;
    case 'generating':
      label = '生成回复中...';
      dataPhase = 'generating';
      break;
    default:
      return null;
  }

  return (
    <div className="run-status-bar" data-phase={dataPhase} data-testid="run-status-bar">
      <div className="run-status-dot" />
      <span className="run-status-label">{label}</span>
    </div>
  );
}
