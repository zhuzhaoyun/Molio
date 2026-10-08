import { useCallback, useState, lazy, Suspense } from 'react';
import { ChatComposer, buildAttachmentPrefix } from './ChatComposer';
import type { PastedImage } from './ChatComposer';
import { useI18n } from '../i18n';
import type { ChatMessage } from '../hooks/useChat';
import type { ActivityInfo } from '@molio/contracts';
import { ChatSessionView } from './ChatSessionView';
import { PanelIcon } from './icons';
import { NoRuntimeCard } from './NoRuntimeCard';
import { AgentsUnavailableCard } from './AgentsUnavailableCard';
import { FirstRunOnboarding } from './home/FirstRunOnboarding';

// 会话产出面板只在 dock 展开时渲染，却把整条 doocs-md/marked/highlight.js
// 依赖链拖进首屏 chunk —— 懒加载（启动性能优化）。
const SessionOutputPanel = lazy(() =>
  import('./SessionOutputPanel').then((m) => ({ default: m.SessionOutputPanel })));

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
  /** agents 列表判定无可用代理（空列表或全部不可用）。请求失败时为 false。 */
  hasNoUsableAgent: boolean;
  /**
   * agents 列表**取不到**（请求失败 / 后端没起来）。
   * 与 hasNoUsableAgent 互斥：前者是「问不到」，后者是「问到了，一个都没有」。
   */
  agentsUnavailable: boolean;
  /** 取不到 agents 列表时的重试回调（必给：否则会渲染出一个点了没反应的「重试」）。 */
  onRetryAgents: () => void;
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
  agentsUnavailable,
  onRetryAgents,
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

  const [dockOpen, setDockOpen] = useState<boolean>(readDockOpen);
  const toggleDock = useCallback(() => {
    setDockOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY_DOCK_OPEN, String(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

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
  //
  // 顺序要紧：先判「取不到」（请求失败），再判「取到了但没有可用的」。
  // 反过来会把「后端连不上」渲染成「没装运行时」——两者对用户的含义与
  // 该做的动作完全不同（一个去检查后端/重试，一个去装运行时）。
  const composerArea = agentsUnavailable ? (
    <AgentsUnavailableCard onRetry={onRetryAgents} />
  ) : agentsReady && hasNoUsableAgent ? (
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
          </div>
        </div>

        <ChatSessionView
          messages={messages}
          isRunning={isRunning}
          activity={activity}
          onSend={onSend}
          onSubmitForm={onSubmitForm}
          onCancel={onCancel}
          onSubmitToolResult={onSubmitToolResult}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onContinue={onContinue}
          onRequestDelete={onRequestDelete}
          onDeleteMessages={onDeleteMessages}
          composerKey="home"
          composerArea={composerArea}
          onOpenConversation={onOpenConversation}
          onDeleteConversations={onDeleteConversations}
        />
        </div>

      {dockOpen && (
        <Suspense fallback={null}>
          <SessionOutputPanel messages={messages} />
        </Suspense>
      )}
      </div>
    );
  }

  // Landing page — no messages yet
  return (
    <div className="home-page home-landing">
      <div className="home-hero-view">
        {/* 首次运行引导 —— 只在落地页出现（有会话说明人已经在用了，不再打扰） */}
        <FirstRunOnboarding />

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
