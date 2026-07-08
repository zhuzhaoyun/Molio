import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../hooks/useChat';
import type { AgentInfo } from '@molio/contracts';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ChatComposer } from './ChatComposer';

interface Props {
  messages: ChatMessage[];
  isRunning: boolean;
  agents: AgentInfo[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  onSend: (message: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
}

export function ChatPane({
  messages,
  isRunning,
  agents,
  selectedAgent,
  onSelectAgent,
  onSend,
  onCancel,
  onNewChat,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  const isEmpty = messages.length === 0;
  const selectedAgentName = agents.find((a) => a.id === selectedAgent)?.name ?? 'Select agent';

  return (
    <div className="chat-pane">
      {/* Header */}
      <div className="chat-header">
        <span className="chat-header-title">Chat</span>
        <select
          value={selectedAgent ?? ''}
          onChange={(e) => onSelectAgent(e.target.value)}
          disabled={isRunning}
        >
          <option value="" disabled>
            {agents.length === 0 ? 'No agents detected' : 'Select agent...'}
          </option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id} disabled={!agent.available}>
              {agent.name}{agent.version ? ` (${agent.version.split(' ')[0]})` : ''}
              {!agent.available ? ' — not installed' : ''}
            </option>
          ))}
        </select>
        <div className="chat-header-actions">
          {messages.length > 0 && !isRunning && (
            <button type="button" className="icon-only" onClick={onNewChat} title="New chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Chat log */}
      <div className="chat-log" ref={logRef}>
        {isEmpty ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">💬</div>
            <div className="chat-empty-title">{selectedAgentName}</div>
            <div className="chat-empty-hint">
              Start typing below to begin a conversation with this agent.
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              if (msg.role === 'user') {
                return <UserMessage key={msg.id} message={msg} />;
              }
              if (msg.role === 'assistant') {
                return <AssistantMessage key={msg.id} message={msg} />;
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
          </>
        )}
      </div>

      {/* Composer */}
      <ChatComposer
        isRunning={isRunning}
        onSend={onSend}
        onCancel={onCancel}
      />
    </div>
  );
}
