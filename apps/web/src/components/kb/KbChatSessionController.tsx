// apps/web/src/components/kb/KbChatSessionController.tsx
//
// 无 DOM 的会话 controller：持有该标签的 `useChatCore`（消息 / SSE 订阅 / 历史加载 /
// resumeRun），并把 imperative API 经 `registerApi` 交出去。渲染完全交给 `children`
// render-prop（面板 view / 全屏壳共用同一份状态）。此文件不渲染任何 DOM。
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ChatMessage as ContractChatMessage, ActivityInfo } from '@molio/contracts';
import { api } from '../../api/client';
import { useChatCore, type CreateRunContext, type ChatMessage } from '../../hooks/useChatCore';
import { kbChatSessionsStore, type ChatSessionTab } from '../../stores/kbChatSessionsStore';
import { chatRuntimeStore } from '../../stores/chatRuntimeStore';
import { type PastedImage, buildAttachmentPrefix } from '../ChatComposer';
import { useI18n } from '../../i18n';
import { WIKI_QUERY_TRIGGER, deriveChatTitle } from './kbChatPrompts';

export interface KbChatSessionApi {
  send: (text: string) => void;
  clear: () => void;
  /** 就地切换：把本会话内容替换为目标会话（更新 store conversationId + 清空 + 从 DB 加载）。 */
  loadConversation: (conversationId: string) => void;
  /** 中断正在跑的 run（daemon 侧 DELETE）。无 run 时是安全的 no-op。
   *  返回 Promise 以便调用方可 await —— 中断后立即重发时，必须先等 cancel 完成，
   *  否则 cancel 的收尾 setState 会覆盖新 run 的 running 状态（D3 并发写风险）。 */
  cancel: () => void | Promise<void>;
}

/** controller 交出去供 view 渲染的状态 + 动作集合（面板 / 全屏共用）。 */
export interface KbChatSessionState {
  messages: ChatMessage[];
  isRunning: boolean;
  activity: ActivityInfo | null;
  conversationId: string | null;
  send: (text: string, opts?: { queueIfRunning?: boolean }) => void;
  cancel: () => void;
  submitToolResult: (toolUseId: string, content: string) => Promise<void>;
  regenerateLast: () => void;
  editAndResend: (messageId: string, newContent: string) => void;
  deleteMessages: (ids: string[]) => Promise<void> | void;
  /** 面板/全屏共用的发送包装：pastedImages 前缀 + qa 首轮 WIKI_QUERY_TRIGGER + selectedText */
  buildSend: (selectedText?: string | null, onSelectedTextConsumed?: () => void)
    => (text: string, pastedImages?: PastedImage[]) => void;
}

export interface KbChatSessionControllerProps {
  session: ChatSessionTab;
  agentId: string | null;
  vaultPath: string | null;
  /** 当前窗口的 vault id — 用于挂载时检测跨库会话泄漏 */
  vaultId: string | null;
  onRunningChange: (sessionId: string, running: boolean) => void;
  /** wiki 完成 → tree refresh */
  onComplete?: () => void;
  /** 历史加载失败（如 404）→ 传入本会话 id，让面板只关报错的那个标签 */
  onLoadError?: (sessionId: string) => void;
  registerApi: (sessionId: string, api: KbChatSessionApi) => void;
  unregisterApi: (sessionId: string) => void;
  /** 把 chat 状态交出去供 view 渲染（render-prop，App 层 Provider 也用它） */
  children: (state: KbChatSessionState) => ReactNode;
}

function toChatMessage(m: ContractChatMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    timestamp: m.timestamp,
    agentId: m.agentId,
    runId: m.runId,
    tools: m.tools as ChatMessage['tools'],
    usage: m.usage,
  };
}

export function KbChatSessionController({
  session, agentId, vaultPath, vaultId,
  onRunningChange, onComplete, onLoadError, registerApi, unregisterApi, children,
}: KbChatSessionControllerProps) {
  const { t } = useI18n();

  const createRun = useCallback(async (ctx: CreateRunContext) => {
    if (!agentId) {
      throw new Error('No agent selected — please choose an agent before sending a message.');
    }
    const contractHistory = ctx.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: m.id, role: m.role as 'user' | 'assistant', content: m.content,
        timestamp: m.timestamp, agentId: m.agentId, runId: m.runId,
        tools: m.tools, usage: m.usage,
      }));
    const result = await api.createRun({
      agentId,
      message: ctx.message,
      // 发送瞬间读 store 快照——pill 选择的模型对下一条消息即时生效
      model: chatRuntimeStore.getState().model ?? undefined,
      cwd: vaultPath ?? undefined,
      conversationId: ctx.conversationId ?? undefined,
      history: contractHistory.length > 0 ? contractHistory : undefined,
    });
    if (result.conversationId) {
      kbChatSessionsStore.updateSession(session.id, { conversationId: result.conversationId });
      const cur = kbChatSessionsStore.getSessions().find((s) => s.id === session.id);
      if (cur && cur.title === '新会话') {
        kbChatSessionsStore.updateSession(session.id, { title: deriveChatTitle(ctx.message) });
      }
    }
    return { runId: result.runId, conversationId: result.conversationId };
  }, [agentId, vaultPath, session.id]);

  // 重新生成 / 编辑重发（消息级工具条）也要走 controller：`useChatCore` 缺少 rewindResend
  // 时 regenerateLast / editAndResend 会直接 no-op（见 useChatCore.ts 的 `if (!rewindResend) return;`）。
  // 语义与旧 App 级 useChat 的 rewindResend 一致（createRun 的镜像：带 agentId/cwd/model）。
  const rewindResend = useCallback(async ({ conversationId, newContent }: { conversationId: string; newContent: string }) => {
    return api.rewindResend(conversationId, {
      newContent,
      agentId: agentId ?? undefined,
      cwd: vaultPath ?? undefined,
      model: chatRuntimeStore.getState().model ?? undefined,
    });
  }, [agentId, vaultPath]);

  const chat = useChatCore({ agentId, createRun, rewindResend, onComplete: session.mode === 'qa' ? undefined : onComplete });

  // #6: 追踪最新消息数。DB 历史加载是异步的——若加载完成前用户已发送消息（乐观消息已入列），
  // 迟到的 setMessages 会覆盖掉乐观消息（conversationId 守卫拦不住：id 未变），这里用它做守卫。
  const messageCountRef = useRef(chat.messages.length);
  messageCountRef.current = chat.messages.length;

  // api 注册：send/clear 通过 ref 转发到最新 chat 方法，api 对象稳定
  const sendRef = useRef(chat.send); sendRef.current = chat.send;
  const setMessagesRef = useRef(chat.setMessages); setMessagesRef.current = chat.setMessages;
  const cancelRef = useRef(chat.cancel); cancelRef.current = chat.cancel;
  const resetRef = useRef(chat.reset); resetRef.current = chat.reset;
  const resumeRef = useRef(chat.resumeRun); resumeRef.current = chat.resumeRun;
  const submitToolResultRef = useRef(chat.submitToolResult); submitToolResultRef.current = chat.submitToolResult;
  const regenerateRef = useRef(chat.regenerateLast); regenerateRef.current = chat.regenerateLast;
  const editRef = useRef(chat.editAndResend); editRef.current = chat.editAndResend;
  const deleteMessagesRef = useRef(chat.deleteMessages); deleteMessagesRef.current = chat.deleteMessages;
  // 防卸载后异步回调（maybeResume 的 listRuns）触发订阅
  const mountedRef = useRef(false);

  // 重挂载/切历史恢复：DB 加载后若该会话存在活跃 run（running/pending），重新订阅回放直播。
  // listRuns 失败 → 退化为静态历史（不阻塞加载）。守卫条件（末条是 user）在 resumeRun 内部。
  const maybeResume = useCallback(async (conversationId: string) => {
    try {
      const runs = await api.listRuns();
      if (!mountedRef.current) return;
      const active = runs.find((r) =>
        r.conversationId === conversationId && (r.status === 'running' || r.status === 'pending'));
      if (active) resumeRef.current({ runId: active.id });
    } catch { /* listRuns 失败 → 退化为静态历史 */ }
  }, []);

  // 挂载时从 DB 加载历史（异步，不用 initialMessages）。
  // 注意：不能用 loadedRef 挡住第二次执行 —— dev 下 StrictMode 会 mount→cleanup→mount，
  // 第一次调用被 cleanup 的 cancelled 丢弃后，第二次必须重跑 fetch，否则历史永远加载不出来。
  // 用 per-effect 的 cancelled 标志即可：StrictMode 下第二次调用是新 fetch 并正常完成。
  useEffect(() => {
    const loadedConversationId = session.conversationId;
    if (!loadedConversationId) return;
    let cancelled = false;
    // 全量导航/刷新（桌面端 reload、浏览器刷新）不会执行 React cleanup —— 在途的历史
    // 加载 fetch 会被中断并 reject，若此时触发 onLoadError → closeSession，会把正在恢复的
    // 会话标签永久清掉（persist 先于新页面写入空列表）。pagehide 在导航/刷新时必然触发，
    // 用它兜底把 cancelled 置真，中断的加载一律丢弃、不误关标签（方案 D 面板任意页面
    // 常驻挂载，恢复加载可能在任意页面进行）。
    const onPageHide = () => { cancelled = true; };
    window.addEventListener('pagehide', onPageHide);
    api.listConversationMessages(loadedConversationId)
      .then((msgs) => {
        if (cancelled) return;
        // #6: 用户在加载完成前已发送消息（messageCount > 0）→ 迟到的 setMessages 会覆盖乐观
        // 消息，直接丢弃 DB 历史（conversationId 守卫拦不住：id 未变）。
        if (messageCountRef.current > 0) return;
        // 竞态守卫：加载期间会话被 clear（conversationId 置 null）或指向新会话 → 丢弃迟到结果
        const cur = kbChatSessionsStore.getSessions().find((s) => s.id === session.id);
        if (!cur || cur.conversationId !== loadedConversationId) return;
        chat.setMessages(msgs.map(toChatMessage), loadedConversationId);
        // 该会话存在活跃 run（回复进行中）→ 重新订阅回放直播，避免 UI 把 run 弄丢
        void maybeResume(loadedConversationId);
        const firstUser = msgs.find((m) => m.role === 'user');
        // 只在该会话标题仍是占位（新会话/加载中）时派生 —— 用户重命名过的不被历史加载覆盖
        const curTitle = kbChatSessionsStore.getSessions().find((s) => s.id === session.id)?.title;
        if (firstUser && session.mode === 'qa' && (curTitle === '新会话' || curTitle === '加载中…')) {
          kbChatSessionsStore.updateSession(session.id, { title: deriveChatTitle(firstUser.content) });
        }
      })
      .catch(() => { if (!cancelled) onLoadError?.(session.id); });
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 会话线程绑定 vault（run 的 cwd）。切换活跃 vault 不得续写旧 vault 的会话线程 ——
  // 重置会话血统，让下一次发送从新线程开始（多窗口「一窗一 vault」会话隔离）。
  // 从旧 useKbChat 的 vault 切换重置移植而来：PR #202 的多会话面板在 vault 切换时
  // 只清 @文件上下文、保留 conversationId，会泄漏旧 vault 线程（multi-window E2E 验证）。
  // 首轮挂载 prev 为 null → 不触发；仅真正的 vault 变化（prev 非空且不同）才重置。
  // reset() 会清空消息 + conversationId + 关闭 SSE，但不会 cancel daemon 进程 ——
  // 与「关闭会话」中途离场一致，遗留 run 的行为可接受（见旧 useKbChat 注释）。
  const prevVaultPathRef = useRef(vaultPath);
  useEffect(() => {
    const prev = prevVaultPathRef.current;
    prevVaultPathRef.current = vaultPath;
    // 跨库判定：会话所属 vault 与当前窗口 vault 不一致——两种场景都会触发：
    // ① SPA 切库（vaultPath 变化）② 多开新窗/重载后首轮挂载继承了旧库会话
    // （此时 vaultPath 首次渲染为 null、vault 加载后才就位，不能依赖 prev===vaultPath 判首挂载）。
    // 重置会话血统并重绑定当前库，避免 cwd=当前库 + conversationId=旧库 的串线；
    // 必须一并更新 vaultId，否则重置后每次重跑判定仍跨库、反复重置。
    const crossVault = session.vaultId != null && vaultId != null && session.vaultId !== vaultId;
    if ((prev !== null && prev !== vaultPath) || crossVault) {
      resetRef.current();
      kbChatSessionsStore.updateSession(session.id, { conversationId: null, vaultId: vaultId ?? session.vaultId });
    }
  }, [vaultPath, session.id, session.vaultId, vaultId]);

  // running 上报（驱动 wiki 互斥判断 + 关闭确认）
  useEffect(() => { onRunningChange(session.id, chat.isRunning); }, [chat.isRunning, session.id, onRunningChange]);

  const apiObj = useMemo<KbChatSessionApi>(() => ({
    send: (text) => sendRef.current(text),
    clear: () => {
      setMessagesRef.current([], null);
      kbChatSessionsStore.updateSession(session.id, { conversationId: null });
    },
    // 就地切换（历史打开不走新标签）：更新 store conversationId → 清空当前 → 从 DB 加载。
    // store 的 openConversation 已把 conversationId 换成目标值，这里负责真正加载内容。
    loadConversation: (conversationId) => {
      kbChatSessionsStore.updateSession(session.id, { conversationId, title: '加载中…' });
      setMessagesRef.current([], conversationId);
      api.listConversationMessages(conversationId)
        .then((msgs) => {
          // 竞态守卫：切换期间又被切换/清除 → 丢弃迟到结果
          const cur = kbChatSessionsStore.getSessions().find((s) => s.id === session.id);
          if (!cur || cur.conversationId !== conversationId) return;
          chat.setMessages(msgs.map(toChatMessage), conversationId);
          // 切到的历史会话若正在生成 → 恢复直播（与重挂载同一启发式）
          void maybeResume(conversationId);
          const firstUser = msgs.find((m) => m.role === 'user');
          // 只在该会话标题仍是占位（新会话/加载中）时派生 —— 用户重命名过的不被历史加载覆盖
          const curTitle = kbChatSessionsStore.getSessions().find((s) => s.id === session.id)?.title;
          if (firstUser && session.mode === 'qa' && (curTitle === '新会话' || curTitle === '加载中…')) {
            kbChatSessionsStore.updateSession(session.id, { title: deriveChatTitle(firstUser.content) });
          }
        })
        .catch(() => onLoadError?.(session.id));
    },
    cancel: () => cancelRef.current(),
  }), [session.id, onLoadError, maybeResume]);
  useEffect(() => {
    registerApi(session.id, apiObj);
    return () => unregisterApi(session.id);
  }, [session.id, apiObj, registerApi, unregisterApi]);

  // 卸载时关闭 SSE（不 cancel run —— 后台任务继续跑，仅断开订阅，防 EventSource 泄漏/卸载后 setState）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resetRef.current();
    };
  }, []);

  // 面板/全屏共用的发送包装：原样搬自旧 KbChatSession.handleSend
  const buildSend = useCallback(
    (selectedText?: string | null, onSelectedTextConsumed?: () => void) =>
      (text: string, pastedImages?: PastedImage[]) => {
        // Inline @/skill refs in `text` were already expanded by ChatComposer.
        const prefix = buildAttachmentPrefix(pastedImages ?? []);
        let message = text;
        if (prefix) message = `${prefix}\n\n${message || ''}`;
        if (selectedText) {
          message = `${t('kb.fileChatContextPrefix')}\n> ${selectedText}\n\n${message}`;
          onSelectedTextConsumed?.();
        }
        const isFirstTurn = chat.conversationId == null;
        const wrapped = session.mode === 'qa' && isFirstTurn ? WIKI_QUERY_TRIGGER(message) : message;
        sendRef.current(wrapped, { queueIfRunning: true });
      },
    [t, session.mode, chat.conversationId],
  );

  const state = useMemo<KbChatSessionState>(() => ({
    messages: chat.messages,
    isRunning: chat.isRunning,
    activity: chat.activity ?? null,
    conversationId: chat.conversationId ?? null,
    send: (text, opts) => sendRef.current(text, opts),
    cancel: () => { void cancelRef.current(); },
    submitToolResult: (toolUseId, content) => submitToolResultRef.current(toolUseId, content),
    regenerateLast: () => { void regenerateRef.current(); },
    editAndResend: (messageId, newContent) => { void editRef.current(messageId, newContent); },
    deleteMessages: (ids) => deleteMessagesRef.current(ids),
    buildSend,
  }), [
    chat.messages, chat.isRunning, chat.activity, chat.conversationId, buildSend,
  ]);

  return <>{children(state)}</>;
}
