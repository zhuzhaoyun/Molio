import { useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { ChatComposer, buildAttachmentPrefix } from './ChatComposer';
import type { PastedImage, FileRef } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { findLastAssistant } from '../utils/workSteps';
import { useSelectMode, messageSelectionStore } from '../stores/messageSelectionStore';
import { SelectionConfirmBar } from './SelectionConfirmBar';
import { RunStatusBar } from './RunStatusBar';
import { ActivityTree } from './ActivityTree';
import type { ChatMessage } from '../hooks/useChatCore';
import type { ActivityInfo } from '@molio/contracts';
import { useI18n } from '../i18n';

export interface ChatSessionViewProps {
  messages: ChatMessage[];
  isRunning: boolean;
  activity?: ActivityInfo | null;
  conversationId?: string | null;

  onSend: (text: string, images?: PastedImage[]) => void;
  onSubmitForm?: (text: string) => void;
  onCancel: () => void;
  onSubmitToolResult?: (toolUseId: string, content: string) => Promise<void>;
  onRegenerate?: () => void;
  onEdit?: (messageId: string, newContent: string) => void;
  onContinue?: () => void;
  onRequestDelete?: (id: string) => void;
  onDeleteMessages?: (ids: string[]) => Promise<void> | void;

  composerKey: string;
  composerInitialFileRefs?: FileRef[];
  composerDisabled?: boolean;
  composerDisabledPlaceholder?: string;
  /**
   * 输入框区的整块替换（如无可用运行时 → NoRuntimeCard）。
   * 提供时直接渲染它，否则渲染由上面 composer* props 组装的 ChatComposer。
   */
  composerArea?: ReactNode;
  /**
   * 日志区容器的类名覆盖（默认 'home-chat-log'）。
   * KB 面板复用时传 'file-chat-messages' 以保留其既有 DOM 结构/样式。
   */
  logClassName?: string;
  /** 输入框区容器的类名覆盖（默认 'home-composer-bar'）；面板传 'file-chat-input'。 */
  composerBarClassName?: string;
  /**
   * 消息为空时渲染在日志区内的内容（面板空态/选中预览）。
   * 提供且 `messages.length === 0` 时替代消息列表；默认不渲染。
   */
  emptyState?: ReactNode;
  /**
   * 内部 ChatComposer 的 React key。面板按「会话:文件」重挂载以重播种 @ 上下文；
   * 默认 undefined（HomePage 不重挂载）。
   */
  composerMountKey?: string;
  /** 历史下拉（仅全屏态需要） */
  onOpenConversation?: (conversationId: string) => void;
  onDeleteConversations?: (ids: string[]) => void;
}

/**
 * 纯视图：渲染一段会话的「消息列表 + 活动树 + 状态条 + 输入框区」。
 * 不含数据获取——状态与回调全部由调用方注入（HomePage / KB 面板 / `/chat` 共用）。
 */
export function ChatSessionView({
  messages,
  isRunning,
  activity,
  onSend,
  onSubmitForm,
  onCancel,
  onSubmitToolResult,
  onRegenerate,
  onEdit,
  onContinue,
  onRequestDelete,
  onDeleteMessages,
  composerKey,
  composerInitialFileRefs,
  composerDisabled,
  composerDisabledPlaceholder,
  composerArea,
  logClassName,
  composerBarClassName,
  emptyState,
  composerMountKey,
  onOpenConversation,
  onDeleteConversations,
}: ChatSessionViewProps) {
  const { t } = useI18n();
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectMode = useSelectMode();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  // Prune stale selected ids whenever the message set changes (streaming,
  // regenerate, etc. may have removed a selected bubble).
  useEffect(() => {
    const present = new Set(messages.map((m) => m.id));
    messageSelectionStore.pruneStale(present);
  }, [messages]);

  // Find the last assistant message ID so only that card stays interactive
  const lastAssistant = useMemo(() => findLastAssistant(messages), [messages]);
  const lastAssistantId = lastAssistant?.id ?? null;

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

  // Wrap onSend to handle pastedImages → message prefix. Inline @/skill refs
  // in `message` were already expanded by ChatComposer before send.
  const handleSend = useCallback(
    (message: string, pastedImages?: PastedImage[]) => {
      const prefix = buildAttachmentPrefix(pastedImages ?? []);
      if (prefix) {
        onSend(`${prefix}\n\n${message || t('home.fileContextFallback')}`);
      } else {
        onSend(message);
      }
    },
    [onSend],
  );

  const composer = composerArea ?? (
    <ChatComposer
      key={composerMountKey}
      composerKey={composerKey}
      isRunning={isRunning}
      onSend={handleSend}
      onCancel={onCancel}
      disabled={composerDisabled}
      disabledPlaceholder={composerDisabledPlaceholder}
      initialFileRefs={composerInitialFileRefs}
      onOpenConversation={onOpenConversation}
      onDeleteConversations={onDeleteConversations}
    />
  );

  return (
    <>
      {/* Chat log */}
      <div className={logClassName ?? 'home-chat-log'} ref={logRef}>
        {messages.length === 0 && emptyState ? emptyState : messages.map((msg) => {
          if (msg.role === 'user') {
            const isLastUser = (() => {
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]!.role === 'user') return messages[i]!.id === msg.id;
              }
              return false;
            })();
            return (
              <UserMessage
                key={msg.id}
                message={msg}
                isLast={isLastUser}
                onEdit={onEdit}
                disabled={isRunning}
                onRequestDelete={onRequestDelete}
              />
            );
          }
          if (msg.role === 'assistant') {
            return (
              <AssistantMessage
                key={msg.id}
                message={msg}
                isLast={msg.id === lastAssistantId}
                onAnswerToolUse={onSubmitToolResult ? onAnswerToolUse : undefined}
                onSubmitForm={onSubmitForm ?? ((text: string) => handleSend(text, []))}
                onRegenerate={msg.id === lastAssistantId ? onRegenerate : undefined}
                onContinue={msg.id === lastAssistantId ? onContinue : undefined}
                onRequestDelete={onRequestDelete}
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

      {/* 后台 subagent/workflow 活动树（activity SSE 事件驱动） */}
      <ActivityTree activity={activity ?? null} />

      {/* 进度状态条: 只在 run 运行时显示 */}
      <RunStatusBar messages={messages} isRunning={isRunning} />

      {/* Composer at the bottom — hidden in selection mode, replaced by the
          confirm bar (input and delete are mutually exclusive). */}
      <div className={composerBarClassName ?? 'home-composer-bar'}>
        {selectMode ? (
          <SelectionConfirmBar
            onDelete={async () => {
              const ids = [...messageSelectionStore.getSelectedIds()];
              try {
                await onDeleteMessages?.(ids);
              } finally {
                messageSelectionStore.exit();
              }
            }}
            onCancel={() => messageSelectionStore.exit()}
          />
        ) : (
          composer
        )}
      </div>
    </>
  );
}
