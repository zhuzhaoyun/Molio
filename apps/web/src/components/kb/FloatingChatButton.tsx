// apps/web/src/components/kb/FloatingChatButton.tsx
import { useKbChatPanelOpen, kbChatSessionsStore } from '../../stores/kbChatSessionsStore';
import { useI18n } from '../../i18n';

/** 全局悬浮对话按钮：面板收起时显示在右下角，点击展开多会话面板。 */
export function FloatingChatButton() {
  const panelOpen = useKbChatPanelOpen();
  const { t } = useI18n();
  if (panelOpen) return null; // 面板展开时不显示按钮
  return (
    <button
      type="button"
      data-testid="floating-chat-btn"
      className="floating-chat-btn"
      onClick={() => kbChatSessionsStore.setPanelOpen(true)}
      title={t('kb.floatingChat')}
      aria-label={t('kb.floatingChat')}
    >
      {/* 白色描边聊天气泡 —— 与全局 SVG 图标体系一致（黄色 emoji 在陶土色实心圆上发闷） */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    </button>
  );
}
