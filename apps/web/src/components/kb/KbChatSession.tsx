// apps/web/src/components/kb/KbChatSession.tsx
//
// 面板态的会话【视图】：从 App 层 `KbChatSessionsProvider` 的 context 取本标签的状态，
// 渲染成 `ChatSessionView`。无 DOM 的状态/逻辑（useChatCore / 历史加载 / resumeRun /
// API 注册）在 `KbChatSessionController.tsx`，由 Provider 常驻挂载 —— 本文件只负责
// 面板特有的外壳类名、空态/选中预览、以及发送包装所需的 selectedText。
import { ChatSessionView } from '../ChatSessionView';
import { messageSelectionStore } from '../../stores/messageSelectionStore';
import { type FileRef } from '../ChatComposer';
import { useI18n } from '../../i18n';
import type { ChatSessionTab } from '../../stores/kbChatSessionsStore';
import { sessionComposerKey, sessionComposerMountKey } from '../../stores/kbChatSessionsStore';
import { useKbChatSessionState } from './KbChatSessionsProvider';

interface KbChatSessionViewProps {
  session: ChatSessionTab;
  /** 面板里非活动标签渲染为 display:none；由调用方给（`/chat` 恒为 true） */
  active: boolean;
  /** 就此提问带入的选中文本（瞬态，首条消息消费）——只影响 view 的 buildSend 调用 */
  selectedText?: string | null;
  onSelectedTextConsumed?: () => void;
}

export function KbChatSession({
  session, active, selectedText, onSelectedTextConsumed,
}: KbChatSessionViewProps) {
  const { t } = useI18n();
  // 状态来自 App 层 Provider 的 controller（同一标签在面板 / `/chat` 共用一份 core）。
  // 首次渲染尚未 publish → null，bridge 的 effect 随后上报并触发重渲染。
  const state = useKbChatSessionState(session.id);

  const initialFileRefs: FileRef[] =
    session.mode === 'qa' && session.filePath && session.vaultId
      ? [{ vaultId: session.vaultId, filePath: session.filePath }]
      : [];

  return (
    <div className="file-chat-session" style={{ display: active ? undefined : 'none' }} data-testid="kb-chat-session">
      {state && (
        <ChatSessionView
          messages={state.messages}
          isRunning={state.isRunning}
          activity={state.activity}
          conversationId={state.conversationId}
          onSend={state.buildSend(selectedText, onSelectedTextConsumed)}
          onSubmitForm={(text) => state.send(text)}
          onCancel={state.cancel}
          onSubmitToolResult={state.submitToolResult}
          onRegenerate={state.regenerateLast}
          onEdit={state.editAndResend}
          onContinue={() => state.send('继续')}
          onRequestDelete={(id) => messageSelectionStore.enterSelection(id, state.messages)}
          onDeleteMessages={state.deleteMessages}
          // 只有活动标签是勾选态宿主：非活动标签（display:none）不得用自己消息集裁剪
          // 全局单例里的选中 id，否则后台会话流式输出会清空当前会话的勾选态。
          pruneSelection={active}
          // key 带 filePath：openQa 把活跃会话重新指向新文件时（updateSession），
          // 重挂载 composer 让 initialFileRefs 重新播种 @ —— 否则 store 变了、
          // 挂载过的输入框永远不更新（#4 语义此前对 UI 无效）。
          // composerKey（草稿命名空间）同样带 filePath：播种出的 @ 文本会被存成
          // 草稿，若草稿只按会话分桶，重指向时旧文件的 @ 草稿会压过新种子；
          // 按会话:文件 分桶后，新文件无草稿 → 新种子胜出，切回旧文件还能恢复其草稿。
          // 两个 key 与全屏态（HomePage）共用同一真值源（见 kbChatSessionsStore）——R5 要求逐字一致。
          composerMountKey={sessionComposerMountKey(session.id, session.filePath)}
          composerKey={sessionComposerKey(session.id, session.filePath)}
          composerInitialFileRefs={initialFileRefs}
          // 面板保留既有 DOM 结构/类名与空态（空态含「就此提问」的选中文本预览）
          logClassName="file-chat-messages"
          composerBarClassName="file-chat-input"
          emptyState={
            <div className="file-chat-empty">
              <div className="file-chat-empty-icon">{session.mode === 'qa' ? '💬' : '🤖'}</div>
              <p>{session.mode === 'qa' ? t('fileChat.ready') : t('kb.chatStarting')}</p>
              {session.mode === 'qa' && selectedText && (
                <div className="file-chat-selected-preview" data-testid="kb-chat-selected-preview">
                  <div className="file-chat-selected-label">{t('fileChat.selection')}</div>
                  <blockquote>{selectedText}</blockquote>
                </div>
              )}
            </div>
          }
        />
      )}
    </div>
  );
}
