import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { ChatMessage } from '../../hooks/useChat';
import type { KbChatMode } from '../../hooks/useKbChat';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import { ChatComposer, type FileRef, type PastedImage } from '../ChatComposer';
import { useI18n } from '../../i18n';
import './FileChatPanel.css';

interface KbChatPanelProps {
  mode: KbChatMode | null;
  messages: ChatMessage[];
  isRunning: boolean;
  /** qa 模式下预载为 @-ref 的当前文件（相对 vault 根）。 */
  filePath: string | null;
  vaultId: string | null;
  /** qa 模式下从预览「就此提问」带入的选中文本。 */
  selectedText?: string | null;
  onSend: (text: string, fileRefs?: FileRef[], pastedImages?: PastedImage[]) => void;
  onCancel: () => void;
  onClose: () => void;
  onSubmitToolResult: (toolUseId: string, content: string) => Promise<boolean>;
  onOpenConversation?: (conversationId: string) => void;
}

export function KbChatPanel({
  mode, messages, isRunning, filePath, vaultId, selectedText,
  onSend, onCancel, onClose, onSubmitToolResult, onOpenConversation,
}: KbChatPanelProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  const onAnswerToolUse = useCallback(async (toolUseId: string, content: string) => {
    await onSubmitToolResult(toolUseId, content);
    return true;
  }, [onSubmitToolResult]);

  // qa 模式预载 @当前文档（与旧 FileChatPanel 一致）；wiki 模式不带 @-ref。
  const initialFileRefs = useMemo<FileRef[]>(
    () => (mode === 'qa' && filePath && vaultId ? [{ vaultId, filePath }] : []),
    [mode, filePath, vaultId],
  );

  // 被动上下文标签（非可切 tab）
  const contextLabel =
    mode === 'qa' ? (filePath ? t('kb.chatContextAboutFile', { file: filePath.split('/').pop() ?? filePath }) : t('kb.askButton'))
    : mode === 'build' ? t('kb.chatContextBuildWiki')
    : mode === 'lint' ? t('kb.chatContextLintWiki')
    : '';

  return (
    <aside
      className="file-chat-panel"
      data-testid="kb-chat-panel"
      style={{ width: panelWidth, minWidth: 280, maxWidth: '50vw' }}
    >
      <div className="file-chat-resize-handle" onMouseDown={handleResizeStart} />
      <div className="file-chat-header">
        <div className="file-chat-header-left">
          <span className="file-chat-label">{contextLabel}</span>
          {isRunning && <span className="file-chat-status">{t('fileChat.running')}</span>}
        </div>
        <button
          type="button"
          className="file-chat-close"
          onClick={onClose}
          title={t('fileChat.close')}
          data-testid="kb-chat-close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="file-chat-messages">
        {messages.length === 0 ? (
          <div className="file-chat-empty">
            <div className="file-chat-empty-icon">{mode === 'qa' ? '💬' : '🤖'}</div>
            <p>{mode === 'qa' ? t('fileChat.ready') : t('kb.chatStarting')}</p>
            {mode === 'qa' && selectedText && (
              <div className="file-chat-selected-preview" data-testid="kb-chat-selected-preview">
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
                return <div key={msg.id} className="msg error">{msg.content}</div>;
              }
              return null;
            })}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <div className="file-chat-input">
        <ChatComposer
          key={mode === 'qa' ? (filePath ?? undefined) : (mode ?? undefined)}
          isRunning={isRunning}
          onSend={onSend}
          onCancel={onCancel}
          initialFileRefs={initialFileRefs}
          onOpenConversation={onOpenConversation}
        />
      </div>
    </aside>
  );
}
