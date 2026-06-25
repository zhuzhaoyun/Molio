/**
 * Wiki Chat Panel — right-side sliding panel for wiki build/ingest/lint/query conversations.
 *
 * Reuses existing message components (UserMessage, AssistantMessage)
 * and ChatComposer for the input area.
 */

import { useEffect, useRef, useMemo, useCallback } from 'react';
import type { WikiOperationType } from '@molio/contracts';
import type { ChatMessage } from '../../hooks/useChat';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import { ChatComposer } from '../ChatComposer';

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

  // Auto-scroll to bottom on new messages
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

  const onAnswerToolUse = useCallback(
    async (toolUseId: string, content: string) => {
      onSubmitToolResult(toolUseId, content);
      return true;
    },
    [onSubmitToolResult],
  );

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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
                    onAnswerToolUse={onAnswerToolUse}
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

      {/* Input — reuse shared ChatComposer */}
      <div className="wiki-chat-input">
        <ChatComposer
          isRunning={isRunning}
          onSend={onSend}
          onCancel={onCancel}
        />
      </div>
    </aside>
  );
}
