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
}

/**
 * 会话标签栏 — 复用 kb-wtab 的滚动模型：内部 .chat-session-tabs 是隐藏滚动条的
 * 横向滚动容器，历史 / + 新建 / 收起 三个按钮钉在栏尾始终可见；标签溢出时显示
 * 右滚指示箭头；激活标签变化时自动滚入可见区。运行中的会话标签显示指示点。
 */
export function ChatSessionTabBar({ sessions, activeSessionId, runningSessionIds, onActivate, onClose, onNewSession, onOpenConversation, onClosePanel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const recompute = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
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

  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: el.scrollWidth, behavior: reduced ? 'auto' : 'smooth' });
  };

  return (
    <div className="chat-session-tabbar" data-testid="kb-chat-session-tabbar">
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
      {canScrollRight && (
        <button
          type="button"
          className="chat-session-tab-more"
          data-testid="kb-chat-session-tab-more"
          aria-label="向右滚动"
          onClick={scrollToEnd}
        >
          ›
        </button>
      )}
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
