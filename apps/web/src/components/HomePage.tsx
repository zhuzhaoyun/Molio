import { useState, useRef, useEffect } from 'react';
import type { AgentInfo } from '@kge/contracts';
import { ChatComposer } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import type { ChatMessage } from '../hooks/useChat';

interface Props {
  agents: AgentInfo[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
  messages: ChatMessage[];
  isRunning: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
}

export function HomePage({
  agents,
  selectedAgent,
  onSelectAgent,
  messages,
  isRunning,
  onSend,
  onCancel,
  onNewChat,
}: Props) {
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  const selectedAgentName = agents.find((a) => a.id === selectedAgent)?.name ?? 'Select agent';

  // If there are messages, show chat layout
  if (messages.length > 0) {
    return (
      <div className="home-page chat-active">
        {/* Header with agent selector on the right */}
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
            <div className="home-agent-dropdown">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
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
            </div>
          </div>
        </div>

        {/* Chat log */}
        <div className="home-chat-log" ref={logRef}>
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return <UserMessage key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
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
      {/* Top-right agent selector */}
      <div className="home-landing-topbar">
        <div className="home-agent-dropdown">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
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
        </div>
      </div>

      {/* Center brand + composer */}
      <div className="home-landing-content">
        <div className="home-brand">
          <div className="home-brand-logo">K</div>
          <div className="home-brand-title">Knowledge Growth Engine</div>
          <div className="home-brand-subtitle">
            Select an agent and start a conversation.
          </div>
        </div>

        <div className="home-composer-wrap">
          <ChatComposer isRunning={isRunning} onSend={onSend} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
