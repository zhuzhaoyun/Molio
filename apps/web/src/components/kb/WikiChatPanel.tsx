/**
 * Wiki Chat Panel — right-side sliding panel for wiki build/ingest/lint/query conversations.
 *
 * Reuses existing message components (UserMessage, AssistantMessage, ToolCard).
 * Pure presentation — the agent drives all interaction through its own tools.
 */

import { useEffect, useRef, useState } from 'react';
import type { WikiOperationType } from '@molio/contracts';
import type { ChatMessage } from '../../hooks/useChat';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';

const OPERATION_LABELS: Record<WikiOperationType, string> = {
  build: '构建 Wiki',
  ingest: 'Ingest',
  lint: '健康检查',
  query: '问答',
  save: '归档',
};

const OPERATION_COLORS: Record<WikiOperationType, string> = {
  build: 'var(--accent)',
  ingest: 'var(--green, #2d8a56)',
  lint: 'var(--amber, #b45309)',
  query: 'var(--blue, #2563eb)',
  save: 'var(--purple, #7c3aed)',
};

interface WikiChatPanelProps {
  messages: ChatMessage[];
  isRunning: boolean;
  operationType: WikiOperationType | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => void;
}

export function WikiChatPanel({
  messages,
  isRunning,
  operationType,
  onSend,
  onCancel,
  onClose,
  onSubmitToolResult,
}: WikiChatPanelProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [text]);

  // Focus textarea when not running
  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus();
  }, [isRunning]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (trimmed && !isRunning) {
      onSend(trimmed);
      setText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAnswerToolUse = async (toolUseId: string, content: string): Promise<boolean> => {
    onSubmitToolResult(toolUseId, content);
    return true;
  };

  const label = operationType ? OPERATION_LABELS[operationType] : 'Wiki';
  const color = operationType ? OPERATION_COLORS[operationType] : 'var(--text-muted)';

  return (
    <aside className="wiki-chat-panel">
      {/* Header */}
      <div className="wiki-chat-header">
        <div className="wiki-chat-header-left">
          <span className="wiki-chat-dot" style={{ background: color }} />
          <span className="wiki-chat-label">{label}</span>
          {isRunning && <span className="wiki-chat-status">运行中…</span>}
        </div>
        <button type="button" className="wiki-chat-close" onClick={onClose} title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="wiki-chat-messages" ref={logRef}>
        {messages.length === 0 ? (
          <div className="wiki-chat-empty">
            <div className="wiki-chat-empty-icon">🤖</div>
            <p>Wiki 助手已就绪</p>
          </div>
        ) : (
          <>
            {messages.map((msg, idx) => {
              if (msg.role === 'user') {
                return <UserMessage key={msg.id} content={msg.content} timestamp={msg.timestamp} />;
              }
              if (msg.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={msg.id}
                    message={msg}
                    isLast={idx === messages.length - 1}
                    onAnswerToolUse={handleAnswerToolUse}
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
          </>
        )}
      </div>

      {/* Input */}
      <div className="wiki-chat-input">
        <div className="wiki-chat-input-shell">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? '等待回复…' : '输入消息…'}
            disabled={isRunning}
            rows={1}
          />
          <div className="wiki-chat-input-actions">
            {isRunning ? (
              <button type="button" className="wiki-btn-stop" onClick={onCancel}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                停止
              </button>
            ) : (
              <button
                type="button"
                className="wiki-btn-send"
                disabled={!text.trim()}
                onClick={handleSend}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
