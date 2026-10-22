import { useRef, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { ChatComposer, buildAttachmentPrefix } from './ChatComposer';
import type { PastedImage, FileRef } from './ChatComposer';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { SessionWriteKindsProvider } from './SessionWriteKinds';
import { findLastAssistant } from '../utils/workSteps';
import { isNearBottom } from './chatScrollPin';
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
  /**
   * 本视图是否为「勾选态的宿主」——决定它是否在 messages 变化时裁剪全局选中集合。
   * 面板把每个会话标签都挂载（非活动者 display:none），而 messageSelectionStore 是
   * **模块级单例**，非活动视图的 pruneStale 会拿它自己的消息集去裁剪别的会话的选中 id，
   * 导致「后台标签流式输出时，当前标签的勾选态被静默清空」。故非活动视图不得 prune。
   * 默认 true（`/chat` 只有单个视图，行为不变）。
   */
  pruneSelection?: boolean;
}

/**
 * 纯视图：渲染一段会话的「消息列表 + 活动树 + 状态条 + 输入框区」。
 * 不含数据获取——状态与回调全部由调用方注入（HomePage / KB 面板 / `/chat` 共用）。
 */
export function ChatSessionView({
  messages,
  isRunning,
  activity,
  conversationId,
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
  pruneSelection = true,
}: ChatSessionViewProps) {
  const { t } = useI18n();
  const logRef = useRef<HTMLDivElement>(null);
  const selectMode = useSelectMode();

  // ── 贴底跟随（stick-to-bottom）─────────────────────────────────────────
  // 规则：用户贴底时，内容长高（流式文本 / 工具卡 / 思考块）就瞬时跟到底；
  // 用户上翻阅读即**脱离**跟随，不再把他拽回底部（浮标供主动回底）。
  //
  // 两个坑决定了写法：
  // ① 不能用 `behavior:'smooth'`：流式每几百毫秒就长高一次，滚动动画被反复打断重启，
  //    内容增长持续快于动画推进，视图越落越远——这正是「回答过程中不跟滚」的根因。
  // ② 不能靠 React 的 messages deps 触发：工具卡/思考块的长高未必改变末条 content，
  //    且渲染与 DOM 尺寸变化之间没有可靠的 React 钩子。故直接观察 DOM 变更。
  const pinnedRef = useRef(true);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const stickToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    // 程序化置底也会走这里：置底后判定为 near bottom，pinned 保持 true（不会自锁）。
    const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    pinnedRef.current = near;
    setShowJumpBottom(!near);
  }, []);

  // 内容长高 → 贴底时跟滚。characterData 覆盖流式文本追加，
  // childList/subtree 覆盖工具卡、思考块、状态条等结构性长高。
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      // 面板里非活动会话标签是 display:none（clientHeight 为 0）：此时别写
      // scrollTop，否则后台会话流式输出会把用户切回时该看的位置清掉。
      if (pinnedRef.current && el.clientHeight > 0) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // 消息条数变化（新消息 / 加载历史）时，贴底才跟到底；
  // 用户上翻时保持原位，不打断阅读。
  useEffect(() => {
    if (pinnedRef.current) stickToBottom();
  }, [messages.length, stickToBottom]);

  // 换会话 = 换上下文：跟随状态复位。否则在 A 会话上翻（脱离跟随）后打开
  // B 会话，B 的历史会停在中段而不是最新处。
  useEffect(() => {
    pinnedRef.current = true;
    setShowJumpBottom(false);
    stickToBottom();
  }, [conversationId, stickToBottom]);

  // Prune stale selected ids whenever the message set changes (streaming,
  // regenerate, etc. may have removed a selected bubble).
  // 仅在「勾选态宿主」视图里裁剪：面板把每个会话标签都挂载（非活动者 display:none），
  // messageSelectionStore 又是模块级单例 —— 非活动视图若也 prune，就会拿它自己的消息集
  // 去裁剪别的会话的选中 id，导致后台标签流式输出时静默清空当前标签的勾选态。
  //
  // 注意 `pruneSelection` 必须在 deps 里（不能只写 [messages]）：标签切走/切回时它会
  // 翻转，effect 因此重跑并按**新活动视图**的消息集裁剪 —— 于是切标签会清掉上一个标签
  // 的勾选态。这是**有意的**（否则确认条会带着别的会话的 id 残留、条数与可见气泡对不上），
  // 不要为了「保住勾选」把 deps 改回 [messages]。
  useEffect(() => {
    if (!pruneSelection) return;
    const present = new Set(messages.map((m) => m.id));
    messageSelectionStore.pruneStale(present);
  }, [messages, pruneSelection]);

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
      // 发消息 = 想看回答：无论此前是否上翻阅读，都恢复跟随（否则新回合的
      // 输出会在用户看不见的地方滚过去）。
      pinnedRef.current = true;
      setShowJumpBottom(false);
      const prefix = buildAttachmentPrefix(pastedImages ?? []);
      if (prefix) {
        onSend(`${prefix}\n\n${message || t('home.fileContextFallback')}`);
      } else {
        onSend(message);
      }
    },
    [onSend, t],
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

  /**
   * 底部容器的类名。输入框位置站的是**空状态卡片**（`composerArea`：无可用运行时 /
   * 取不到运行时）而非输入框时，加 `--card` 修饰让它让出「输入栏」的装饰 —— 那道全宽
   * 分隔缝与白底是给输入框的，卡片自带边框阴影，白底会让它看起来贴在一块不同的表面上，
   * 10px 留白也让 200+px 的卡片上下只剩 10px。
   *
   * **只在卡片真的在位时加**：这个容器同时也承载勾选态的确认条（下方 selectMode 分支），
   * 而确认条依赖容器的这套装饰。
   */
  const barClass = composerArea && !selectMode
    ? `${composerBarClassName ?? 'home-composer-bar'} home-composer-bar--card`
    : composerBarClassName ?? 'home-composer-bar';

  return (
    // 写入的「新建 / 更新」判据要会话级上下文（写之前该路径出现过没有），
    // 逐消息的产物横幅自己判不出来 —— 这里算一次，供其与产出面板共用。
    <SessionWriteKindsProvider messages={messages}>
    <>
      {/* Chat log */}
      <div
        className={logClassName ?? 'home-chat-log'}
        ref={logRef}
        onScroll={handleLogScroll}
        data-testid="chat-log"
      >
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
                conversationId={conversationId}
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
        {/* 回到底部浮标：仅「上翻脱离跟随」时出现。sticky 让它停在滚动视口底部，
            又不脱离消息流（不新增一条占用页面空间的行）。 */}
        {messages.length > 0 && !selectMode && (
          <button
            type="button"
            className="chat-jump-bottom"
            data-testid="chat-jump-bottom"
            style={{ display: showJumpBottom ? undefined : 'none' }}
            onClick={() => {
              pinnedRef.current = true;
              setShowJumpBottom(false);
              stickToBottom();
              // 浮标隐藏后消息区高度收回，一次 rAF 让置底落在收回之后的真实底部。
              requestAnimationFrame(stickToBottom);
            }}
            title={t('chat.jumpToBottom')}
            aria-label={t('chat.jumpToBottom')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
          </button>
        )}
      </div>

      {/* 后台 subagent/workflow 活动树（activity SSE 事件驱动） */}
      <ActivityTree activity={activity ?? null} />

      {/* 进度状态条: 只在 run 运行时显示 */}
      <RunStatusBar messages={messages} isRunning={isRunning} />

      {/* Composer at the bottom — hidden in selection mode, replaced by the
          confirm bar (input and delete are mutually exclusive). */}
      <div className={barClass}>
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
    </SessionWriteKindsProvider>
  );
}
