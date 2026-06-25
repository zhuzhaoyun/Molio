import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { ChatMessage } from '../../hooks/useChat';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import { ChatComposer } from '../ChatComposer';
import { useI18n } from '../../i18n';
import './FileChatPanel.css';

interface FileChatPanelProps {
  messages: ChatMessage[];
  isRunning: boolean;
  /** File path for the context badge. */
  filePath: string | null;
  /** Selected text from the preview (via "就此提问" float button). Shown in empty state. */
  selectedText?: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => void;
  onOpenConversation?: (conversationId: string) => void;
}

function extractFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function FileChatPanel({
  messages,
  isRunning,
  filePath,
  selectedText,
  onSend,
  onCancel,
  onClose,
  onSubmitToolResult,
  onOpenConversation,
}: FileChatPanelProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Resizable panel width
  const [panelWidth, setPanelWidth] = useState(360);
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = resizingRef.current.startX - e.clientX;
      const newWidth = Math.min(
        Math.max(resizingRef.current.startWidth + delta, 280),
        window.innerWidth * 0.5,
      );
      setPanelWidth(newWidth);
    };
    const handleMouseUp = () => {
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

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

  const fileName = filePath ? extractFileName(filePath) : null;

  return (
    <aside
      className="file-chat-panel"
      data-testid="file-chat-panel"
      style={{ width: panelWidth, minWidth: 280, maxWidth: '50vw' }}
    >
      {/* Resize handle */}
      <div
        className="file-chat-resize-handle"
        data-testid="file-chat-resize-handle"
        onMouseDown={handleResizeStart}
      />
      {/* Header */}
      <div className="file-chat-header">
        <div className="file-chat-header-left">
          <span className="file-chat-label">{t('fileChat.askFile')}</span>
          {fileName && (
            <span className="file-chat-context" title={filePath ?? undefined}>
              {fileName}
            </span>
          )}
          {isRunning && <span className="file-chat-status">{t('fileChat.running')}</span>}
        </div>
        <button
          type="button"
          className="file-chat-close"
          onClick={onClose}
          title={t('fileChat.close')}
          data-testid="file-chat-close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="file-chat-messages">
        {messages.length === 0 ? (
          <div className="file-chat-empty">
            <div className="file-chat-empty-icon">💬</div>
            <p>{t('fileChat.ready')}</p>
            {fileName && <p className="file-chat-empty-hint">{t('fileChat.contextLabel')}{fileName}</p>}
            {selectedText && (
              <div className="file-chat-selected-preview" data-testid="file-chat-selected-preview">
                <div className="file-chat-selected-label">{t('fileChat.selection')}</div>
                <blockquote>{selectedText}</blockquote>
              </div>
            )}
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

      {/* Input */}
      <div className="file-chat-input">
        {/* FileChatPanel's send path is text-only today; explicitly accept only
            the text arg from ChatComposer so fileRefs/pastedImages are not
            silently accepted then discarded. Wire them through if/when this
            panel gains attachment support. */}
        <ChatComposer
          isRunning={isRunning}
          onSend={(text) => onSend(text)}
          onCancel={onCancel}
          onOpenConversation={onOpenConversation}
        />
      </div>
    </aside>
  );
}
