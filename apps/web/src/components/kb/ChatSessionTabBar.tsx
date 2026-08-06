// apps/web/src/components/kb/ChatSessionTabBar.tsx
import type { ChatSessionTab } from '../../stores/kbChatSessionsStore';

interface Props {
  sessions: ChatSessionTab[];
  activeSessionId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession: () => void;
}

export function ChatSessionTabBar({ sessions, activeSessionId, onActivate, onClose, onNewSession }: Props) {
  return (
    <div className="chat-session-tabbar" data-testid="kb-chat-session-tabbar">
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-session-tab${s.id === activeSessionId ? ' is-active' : ''}`}
          data-testid="kb-chat-session-tab"
          data-session-id={s.id}
          onClick={() => onActivate(s.id)}
        >
          <span className="chat-session-tab-icon">{s.mode === 'qa' ? '💬' : '⚙️'}</span>
          <span className="chat-session-tab-title">{s.title}</span>
          <button
            type="button"
            className="chat-session-tab-close"
            data-testid="kb-chat-session-tab-close"
            aria-label="关闭会话"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="chat-session-tab-add"
        data-testid="kb-chat-session-new"
        title="新会话"
        onClick={onNewSession}
      >
        +
      </button>
    </div>
  );
}
