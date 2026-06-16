interface Props {
  content: string;
  timestamp: number;
}

export function UserMessage({ content, timestamp }: Props) {
  return (
    <div className="msg user" data-testid="user-message">
      <div className="role">
        <span className="msg-time">{formatTime(timestamp)}</span>
      </div>
      <div className="user-text">{content}</div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
