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
      💬
    </button>
  );
}
