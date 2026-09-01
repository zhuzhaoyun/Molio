import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { ChatComposer, buildAttachmentPrefix } from './ChatComposer';
import type { PastedImage } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { findLastAssistant } from '../utils/workSteps';
import { useI18n } from '../i18n';
import { useSelectMode, messageSelectionStore } from '../stores/messageSelectionStore';
import { SelectionConfirmBar } from './SelectionConfirmBar';
import type { ChatMessage } from '../hooks/useChat';
import { RunStatusBar } from './RunStatusBar';
import { ActivityTree } from './ActivityTree';
import type { ActivityInfo } from '@molio/contracts';
import { PanelIcon } from './icons';
import { SessionOutputPanel } from './SessionOutputPanel';
import { NoRuntimeCard } from './NoRuntimeCard';

const STORAGE_KEY_DOCK_OPEN = 'molio.home-dock-open';
function readDockOpen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY_DOCK_OPEN) === 'true'; } catch { return false; }
}

// 品牌 logo（public/images/main.png）——与官网 landing-page/images/new/main.png 同源副本
const LOGO_MAIN_URL = `${import.meta.env.BASE_URL}images/main.png`;

interface Props {
  selectedAgentName: string | null;
  /** agents 列表是否已加载完成（避免加载中闪空状态卡片）。 */
  agentsReady: boolean;
  /** agents 列表判定无可用代理（空列表或全部不可用）。 */
  hasNoUsableAgent: boolean;
  /** 无可用代理时跳转「设置 → 运行时」的回调。 */
  onOpenRuntimes: () => void;
  messages: ChatMessage[];
  isRunning: boolean;
  /** Live background subagent/workflow activity (null = nothing to show). */
  activity?: ActivityInfo | null;
  onSend: (message: string) => void;
  /** Form fallback for AskUserQuestion answers — must reach the agent
   *  IMMEDIATELY (never queued): the agent is paused waiting for the answer,
   *  so queueing it would deadlock. Mirrors KbChatSession's unflagged send. */
  onSubmitForm?: (text: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
  onSubmitToolResult?: (toolUseId: string, content: string) => Promise<void>;
  onOpenConversation?: (conversationId: string) => void;
  onDeleteConversations?: (ids: string[]) => void;
  onRegenerate?: () => void;
  onEdit?: (messageId: string, newContent: string) => void;
  onContinue?: () => void;
  onRequestDelete?: (id: string) => void;
  onDeleteMessages?: (ids: string[]) => void;
}

export function HomePage({
  selectedAgentName,
  agentsReady,
  hasNoUsableAgent,
  onOpenRuntimes,
  messages,
  isRunning,
  activity,
  onSend,
  onSubmitForm,
  onCancel,
  onNewChat,
  onSubmitToolResult,
  onOpenConversation,
  onDeleteConversations,
  onRegenerate,
  onEdit,
  onContinue,
  onRequestDelete,
  onDeleteMessages,
}: Props) {
  const { t } = useI18n();
  const logRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selectMode = useSelectMode();

  const [dockOpen, setDockOpen] = useState<boolean>(readDockOpen);
  const toggleDock = useCallback(() => {
    setDockOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY_DOCK_OPEN, String(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

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

  // 无可用代理时用空状态卡片替代输入框，引导用户去「设置 → 运行时」安装。
  // 用 agents 列表判定（hasNoUsableAgent）而非 selection：selection 在首帧绘制后
  // 才生效会闪空状态卡片，且所选 agent 被移除时 selection 会 stale。
  const composerArea = agentsReady && hasNoUsableAgent ? (
    <NoRuntimeCard onOpenRuntimes={onOpenRuntimes} />
  ) : (
    <ChatComposer
      composerKey="home"
      isRunning={isRunning}
      onSend={handleSend}
      onCancel={onCancel}
      disabled={!selectedAgentName}
      disabledPlaceholder={t('home.noAgent')}
      onOpenConversation={onOpenConversation}
      onDeleteConversations={onDeleteConversations}
    />
  );

  // If there are messages, show chat layout
  if (messages.length > 0) {
    return (
      <div className="home-page chat-active">
        <div className="home-chat-col">
        {/* Header */}
        <div className="home-header">
          <div className="home-header-left">
            <img className="home-header-logo" src={LOGO_MAIN_URL} alt="Molio" />
            <span className="home-header-title">Molio</span>
          </div>
          <div className="home-header-right">
            {!isRunning && (
              <button type="button" data-testid="new-chat-btn" className="icon-only" onClick={onNewChat} title={t('home.newChat')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
            <button
              type="button"
              data-testid="home-output-toggle"
              className="icon-only"
              aria-pressed={dockOpen}
              aria-label={t('output.toggle')}
              title={t('output.toggle')}
              onClick={toggleDock}
            >
              <PanelIcon size={16} />
            </button>
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
        <div className="home-composer-bar">
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
            composerArea
          )}
        </div>
        </div>

      {dockOpen && <SessionOutputPanel messages={messages} />}
      </div>
    );
  }

  // Landing page — no messages yet
  return (
    <div className="home-page home-landing">
      <div className="home-hero-view">
        {/* Hero */}
        <div className="home-hero">
          <div className="home-hero__brand">
            <img className="home-hero__brand-mark" src={LOGO_MAIN_URL} alt="Molio" />
            <span className="home-hero__brand-name" data-testid="hero-brand">Molio</span>
          </div>
          <p className="home-hero__tagline" data-testid="hero-tagline">{t('home.tagline')}</p>
        </div>

        {/* Composer */}
        <div className="home-composer-wrap">
          {composerArea}
        </div>
      </div>
    </div>
  );
}
