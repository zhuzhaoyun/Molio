import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { ChatComposer, buildAttachmentPrefix } from './ChatComposer';
import type { PastedImage, FileRef } from './ChatComposer';
import { useI18n } from '../i18n';
import { ChatSessionView } from './ChatSessionView';
import { PanelIcon } from './icons';
import { NoRuntimeCard } from './NoRuntimeCard';
import { AgentsUnavailableCard } from './AgentsUnavailableCard';
import { FirstRunOnboarding } from './home/FirstRunOnboarding';
import { messageSelectionStore } from '../stores/messageSelectionStore';
import {
  kbChatSessionsStore, useKbChatActiveSessionId, useKbChatSessions,
} from '../stores/kbChatSessionsStore';
import { useKbChatSessionState, useKbChatSessionApi } from './kb/KbChatSessionsProvider';

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

/** 无活动会话时（首次发送前）落地页输入框的草稿命名空间。 */
const LANDING_COMPOSER_KEY = 'chat:landing';

/** 活动会话的输入框命名空间 —— 必须与 KB 面板 `KbChatSession` 完全一致，
 *  两个视图（面板态 / `/chat` 全屏态）才能共享同一份 composer 草稿。 */
function sessionComposerKey(id: string, filePath: string | null | undefined): string {
  return `kb:${id}:${filePath ?? ''}`;
}

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
  /** 页头「+」：新建一个会话标签。 */
  onNewChat: () => void;
  /** 输入框历史下拉：打开某个历史会话（就地切换活动会话）。 */
  onOpenConversation?: (conversationId: string) => void;
  /** 输入框历史下拉删除会话后通知上层做收敛。 */
  onDeleteConversations?: (ids: string[]) => void;
}

/**
 * `/chat` —— 悬浮对话面板的「全屏态」。
 *
 * 数据源是 `kbChatSessionsStore` 的**活动标签**（与悬浮面板同一份会话状态，见
 * `KbChatSessionsProvider`）；不再是 App 级独立会话。两种形态：
 *  - 活动标签有消息 → 全屏 shell（页头 + `ChatSessionView(活动标签)` + 产出面板 dock）；
 *  - 无活动标签 / 活动标签为空 → landing（hero + 首次引导 + 输入框），首次发送建标签。
 */
export function HomePage({
  selectedAgentName,
  agentsReady,
  hasNoUsableAgent,
  agentsUnavailable,
  onRetryAgents,
  onOpenRuntimes,
  onNewChat,
  onOpenConversation,
  onDeleteConversations,
}: Props) {
  const { t } = useI18n();

  // 活动会话（与面板共用上下文里的同一份状态，两个视图渲染同一会话）。
  const activeSessionId = useKbChatActiveSessionId();
  const sessions = useKbChatSessions();
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const state = useKbChatSessionState(activeSessionId);
  const { getApi } = useKbChatSessionApi();

  const [dockOpen, setDockOpen] = useState<boolean>(readDockOpen);
  const toggleDock = useCallback(() => {
    setDockOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY_DOCK_OPEN, String(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  // 落地页首次发送：没有活动会话就建一个 qa 标签，然后把消息投给它的 controller。
  // controller 尚未注册（新标签 mount 中）时挂起，待其就绪（state 发布 + getApi 可解析）后投递。
  const [pendingSend, setPendingSend] = useState<{ id: string; text: string } | null>(null);
  const handleLandingSend = useCallback(
    (message: string, pastedImages?: PastedImage[]) => {
      const prefix = buildAttachmentPrefix(pastedImages ?? []);
      const text = prefix ? `${prefix}\n\n${message || t('home.fileContextFallback')}` : message;
      let targetId = activeSessionId;
      if (!targetId) {
        const res = kbChatSessionsStore.openSession({
          mode: 'qa', title: '新会话', conversationId: null, filePath: null,
        });
        if (!res.tab) return; // 达标签上限：放弃（输入框已由 ChatComposer 清空）
        targetId = res.tab.id;
      }
      const api = getApi(targetId);
      if (api) { api.send(text); return; }
      setPendingSend({ id: targetId, text });
    },
    [activeSessionId, getApi, t],
  );

  // controller 就绪 → 投递挂起的首条消息。目标已成为活动会话且其 state 已发布即为就绪信号。
  useEffect(() => {
    if (!pendingSend) return;
    if (pendingSend.id !== activeSessionId || state == null) return;
    const api = getApi(pendingSend.id);
    if (!api) return;
    setPendingSend(null);
    api.send(pendingSend.text);
  }, [pendingSend, activeSessionId, state, getApi]);

  // 无可用代理时用空状态卡片替代输入框（判定照搬原 landing 分支）。
  const noRuntime = agentsReady && hasNoUsableAgent;
  const noRuntimeCard = <NoRuntimeCard onOpenRuntimes={onOpenRuntimes} />;

  /**
   * 输入框位置的兜底节点 —— 两态（全屏 shell / landing）共用同一个值。
   *
   * 顺序要紧：先判「取不到」（请求失败），再判「取到了但没有可用的」。
   * 反过来会把「后端连不上」渲染成「没装运行时」—— 两者对用户的含义与该做的
   * 动作完全不同（一个去检查后端/重试，一个去装运行时）。
   * null = 两态都不是，正常渲染输入框。
   */
  const composerFallback = agentsUnavailable ? (
    <AgentsUnavailableCard onRetry={onRetryAgents} />
  ) : noRuntime ? noRuntimeCard : null;

  const hasMessages = (state?.messages.length ?? 0) > 0;

  // ── 全屏 shell：活动标签有消息 ──
  if (hasMessages && state && activeSession) {
    const initialFileRefs: FileRef[] =
      activeSession.mode === 'qa' && activeSession.filePath && activeSession.vaultId
        ? [{ vaultId: activeSession.vaultId, filePath: activeSession.filePath }]
        : [];
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
            {!state.isRunning && (
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
          messages={state.messages}
          isRunning={state.isRunning}
          activity={state.activity}
          conversationId={state.conversationId}
          onSend={state.buildSend()}
          onSubmitForm={(text) => state.send(text)}
          onCancel={state.cancel}
          onSubmitToolResult={state.submitToolResult}
          onRegenerate={state.regenerateLast}
          onEdit={state.editAndResend}
          onContinue={() => state.send('继续')}
          onRequestDelete={(id) => messageSelectionStore.enterSelection(id, state.messages)}
          onDeleteMessages={state.deleteMessages}
          // composerKey/composerMountKey 与面板 `KbChatSession` 完全一致：
          // 面板态与全屏态共享同一份草稿、同一套 @ 上下文播种。
          composerKey={sessionComposerKey(activeSession.id, activeSession.filePath)}
          composerMountKey={`${activeSession.id}:${activeSession.filePath ?? ''}`}
          composerInitialFileRefs={initialFileRefs}
          composerDisabled={!selectedAgentName}
          composerDisabledPlaceholder={t('home.noAgent')}
          composerArea={composerFallback ?? undefined}
          onOpenConversation={onOpenConversation}
          onDeleteConversations={onDeleteConversations}
        />
        </div>

      {dockOpen && (
        <Suspense fallback={null}>
          <SessionOutputPanel messages={state.messages} />
        </Suspense>
      )}
      </div>
    );
  }

  // ── landing：无活动标签 / 活动标签为空 ──
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
          {composerFallback ?? (
            <ChatComposer
              // 有活动会话（可能刚新建、尚无消息）时沿用其命名空间，与全屏 shell 的
              // composerKey 一致 → 两态之间切换不丢草稿。
              composerKey={activeSession ? sessionComposerKey(activeSession.id, activeSession.filePath) : LANDING_COMPOSER_KEY}
              isRunning={state?.isRunning ?? false}
              onSend={handleLandingSend}
              onCancel={state ? state.cancel : () => {}}
              disabled={!selectedAgentName}
              disabledPlaceholder={t('home.noAgent')}
              onOpenConversation={onOpenConversation}
              onDeleteConversations={onDeleteConversations}
            />
          )}
        </div>
      </div>
    </div>
  );
}
