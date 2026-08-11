// apps/web/src/components/kb/ChatSessionTabBar.tsx
import { useEffect, useRef, useState } from 'react';
import type { ChatSessionTab } from '../../stores/kbChatSessionsStore';
import { ConversationHistoryMenu } from '../ConversationHistoryMenu';

interface Props {
  sessions: ChatSessionTab[];
  activeSessionId: string | null;
  /** 正在运行的会话 id（驱动标签上的运行指示点） */
  runningSessionIds: ReadonlySet<string>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession: () => void;
  /** 从历史下拉打开会话（去重入标签） */
  onOpenConversation: (conversationId: string) => void;
  /** 收起面板（保留标签，后台任务继续） */
  onClosePanel: () => void;
  /** 是否停靠侧边栏形态（驱动停靠/悬浮切换按钮的图标与 pressed 态） */
  docked?: boolean;
  /** 停靠 ⇄ 悬浮 切换（按钮，带过渡动画） */
  onToggleDock?: () => void;
  /** 头部拖拽：悬浮移动 / 停靠时拖离。返回 true 表示开始拖动（调用方应 setPointerCapture）。 */
  onHeaderDragStart?: (e: React.PointerEvent<HTMLDivElement>) => boolean;
  onHeaderDragMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onHeaderDragEnd?: () => void;
}

/** 停靠到侧边栏（面板右缘带分隔线） */
function DockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
/** 恢复悬浮（窗口 + 弹出箭头） */
function FloatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M21 3l-8 8" />
      <rect x="3" y="9" width="12" height="12" rx="1.5" />
    </svg>
  );
}

/**
 * 会话标签栏 — 复用 kb-wtab 的滚动模型：内部 .chat-session-tabs 是隐藏滚动条的
 * 横向滚动容器；溢出时显示 ‹ › 左右翻页箭头（无原生滚动条）；历史 / + 新建 / 收起
 * 三个按钮钉在栏尾始终可见；激活标签变化时自动滚入可见区。运行中的会话标签显示指示点。
 */
export function ChatSessionTabBar({ sessions, activeSessionId, runningSessionIds, onActivate, onClose, onNewSession, onOpenConversation, onClosePanel, docked = false, onToggleDock, onHeaderDragStart, onHeaderDragMove, onHeaderDragEnd }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const recompute = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  // Recompute overflow on mount, tab changes, and resize.
  useEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sessions.length]);

  // Scroll the active tab into view whenever it changes or a tab is added.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeSessionId, sessions.length]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <div
      className="chat-session-tabbar"
      data-testid="kb-chat-session-tabbar"
      onPointerDown={(e) => {
        // 标签/按钮不触发面板移动，保持各自点击语义；其余空白处开始拖拽移动
        const t = e.target as HTMLElement;
        if (t.closest('button, [role="button"]')) return;
        if (onHeaderDragStart && onHeaderDragStart(e)) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={onHeaderDragMove}
      onPointerUp={onHeaderDragEnd}
      onPointerCancel={onHeaderDragEnd}
    >
      <button
        type="button"
        className="chat-session-tab-arrow"
        data-testid="kb-chat-session-tab-arrow-left"
        hidden={!canLeft}
        aria-label="向左滚动"
        onClick={() => scrollBy(-1)}
      >
        ‹
      </button>
      <div className="chat-session-tabs" ref={scrollRef} onScroll={recompute}>
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId;
          const isRunning = runningSessionIds.has(s.id);
          return (
            <div
              key={s.id}
              className={`chat-session-tab${isActive ? ' is-active' : ''}${isRunning ? ' is-running' : ''}`}
              data-testid="kb-chat-session-tab"
              data-session-id={s.id}
              ref={isActive ? activeRef : null}
              role="button"
              tabIndex={0}
              aria-current={isActive ? 'true' : undefined}
              title={s.title}
              onClick={() => onActivate(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onActivate(s.id);
                }
              }}
            >
              {isRunning && <span className="chat-session-tab-running" data-testid="kb-chat-session-running" />}
              <span className="chat-session-tab-icon">{s.mode === 'qa' ? '💬' : '⚙️'}</span>
              <span className="chat-session-tab-title">{s.title}</span>
              <button
                type="button"
                className="chat-session-tab-close"
                data-testid="kb-chat-session-tab-close"
                aria-label="关闭会话"
                title="关闭"
                onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="chat-session-tab-arrow"
        data-testid="kb-chat-session-tab-arrow-right"
        hidden={!canRight}
        aria-label="向右滚动"
        onClick={() => scrollBy(1)}
      >
        ›
      </button>
      <ConversationHistoryMenu
        onSelect={onOpenConversation}
        align="down"
        buttonClassName="chat-session-tab-history"
        buttonTestId="kb-chat-session-history"
      />
      <button
        type="button"
        className="chat-session-tab-add"
        data-testid="kb-chat-session-new"
        title="新会话"
        onClick={onNewSession}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        type="button"
        className="chat-session-tab-dock"
        data-testid="kb-chat-dock-toggle"
        aria-label={docked ? '切换为悬浮' : '停靠到侧边栏'}
        aria-pressed={docked}
        title={docked ? '切换为悬浮' : '停靠到侧边栏'}
        onClick={onToggleDock}
      >
        {docked ? <FloatIcon /> : <DockIcon />}
      </button>
      <button
        type="button"
        className="chat-session-tab-close-panel"
        data-testid="kb-chat-close"
        aria-label="收起面板"
        title="收起面板"
        onClick={onClosePanel}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
