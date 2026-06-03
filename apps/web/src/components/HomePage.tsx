import { useRef, useEffect, useCallback, useMemo } from 'react';
import { ChatComposer } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import type { ChatMessage } from '../hooks/useChat';

interface Props {
  selectedAgentName: string | null;
  messages: ChatMessage[];
  isRunning: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
  onSubmitToolResult?: (toolUseId: string, content: string) => Promise<void>;
}

export function HomePage({
  selectedAgentName,
  messages,
  isRunning,
  onSend,
  onCancel,
  onNewChat,
  onSubmitToolResult,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  // Find the last assistant message ID so only that card stays interactive
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  // Wire onAnswerToolUse: route tool_result back to the open stream-json child
  const onAnswerToolUse = useCallback(
    async (toolUseId: string, content: string) => {
      if (!onSubmitToolResult) return false;
      try {
        await onSubmitToolResult(toolUseId, content);
        return true;
      } catch {
        return false;
      }
    },
    [onSubmitToolResult],
  );

  // If there are messages, show chat layout
  if (messages.length > 0) {
    return (
      <div className="home-page chat-active">
        {/* Header */}
        <div className="home-header">
          <div className="home-header-left">
            <span className="home-header-logo">K</span>
            <span className="home-header-title">Knowledge Growth Engine</span>
          </div>
          <div className="home-header-right">
            {!isRunning && (
              <button type="button" className="icon-only" onClick={onNewChat} title="New chat">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
            {selectedAgentName && (
              <span className="home-active-agent">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                {selectedAgentName}
              </span>
            )}
          </div>
        </div>

        {/* Chat log */}
        <div className="home-chat-log" ref={logRef}>
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return <UserMessage key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
            }
            if (msg.role === 'assistant') {
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  isLast={msg.id === lastAssistantId}
                  onAnswerToolUse={onSubmitToolResult ? onAnswerToolUse : undefined}
                  onSubmitForm={onSend}
                />
              );
            }
            if (msg.role === 'error') {
              return (
                <div key={msg.id} className="msg error">
                  {msg.content}
                </div>
              );
            }
            return null;
          })}
          <div ref={bottomRef} />
        </div>

        {/* Composer at the bottom */}
        <div className="home-composer-bar">
          <ChatComposer isRunning={isRunning} onSend={onSend} onCancel={onCancel} />
        </div>
      </div>
    );
  }

  // Landing page — no messages yet
  return (
    <div className="home-page home-landing">
      {/* Center brand + composer */}
      <div className="home-landing-content">
        <div className="home-brand">
          <div className="home-brand-logo">K</div>
          <div className="home-brand-title">Knowledge Growth Engine</div>
          <div className="home-brand-subtitle">
            {selectedAgentName
              ? `Chat with ${selectedAgentName}. Set a different default in Runtimes.`
              : 'Set a default runtime in Runtimes, then start chatting.'}
          </div>
        </div>

        <div className="home-composer-wrap">
          <ChatComposer isRunning={isRunning} onSend={onSend} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
