// apps/web/src/components/kb/KbChatSession.tsx
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ChatMessage as ContractChatMessage } from '@molio/contracts';
import { api } from '../../api/client';
import { useChatCore, type CreateRunContext, type ChatMessage } from '../../hooks/useChatCore';
import { kbChatSessionsStore, type ChatSessionTab } from '../../stores/kbChatSessionsStore';
import { UserMessage } from '../UserMessage';
import { AssistantMessage } from '../AssistantMessage';
import { ChatComposer, type FileRef, type PastedImage, buildAttachmentPrefix } from '../ChatComposer';
import { ActivityTree } from '../ActivityTree';
import { useI18n } from '../../i18n';
import { WIKI_QUERY_TRIGGER } from './kbChatPrompts';

export interface KbChatSessionApi {
  send: (text: string) => void;
  clear: () => void;
  /** 中断正在跑的 run（daemon 侧 DELETE）。无 run 时是安全的 no-op。
   *  返回 Promise 以便调用方可 await —— 中断后立即重发时，必须先等 cancel 完成，
   *  否则 cancel 的收尾 setState 会覆盖新 run 的 running 状态（D3 并发写风险）。 */
  cancel: () => void | Promise<void>;
}

interface KbChatSessionProps {
  session: ChatSessionTab;
  active: boolean;
  agentId: string | null;
  vaultPath: string | null;
  /** 就此提问带入的选中文本（瞬态，首条消息消费） */
  selectedText?: string | null;
  onSelectedTextConsumed?: () => void;
  onRunningChange: (sessionId: string, running: boolean) => void;
  /** wiki 完成 → tree refresh */
  onComplete?: () => void;
  onLoadError?: () => void;
  registerApi: (sessionId: string, api: KbChatSessionApi) => void;
  unregisterApi: (sessionId: string) => void;
  /** 从 composer 历史下拉打开会话 */
  onOpenConversation?: (conversationId: string) => void;
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

export function KbChatSession({
  session, active, agentId, vaultPath, selectedText, onSelectedTextConsumed,
  onRunningChange, onComplete, onLoadError, registerApi, unregisterApi, onOpenConversation,
}: KbChatSessionProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);

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
      cwd: vaultPath ?? undefined,
      conversationId: ctx.conversationId ?? undefined,
      history: contractHistory.length > 0 ? contractHistory : undefined,
    });
    if (result.conversationId) {
      kbChatSessionsStore.updateSession(session.id, { conversationId: result.conversationId });
      const cur = kbChatSessionsStore.getSessions().find((s) => s.id === session.id);
      if (cur && cur.title === '新会话') {
        kbChatSessionsStore.updateSession(session.id, { title: ctx.message.slice(0, 24) });
      }
    }
    return { runId: result.runId, conversationId: result.conversationId };
  }, [agentId, vaultPath, session.id]);

  const chat = useChatCore({ agentId, createRun, onComplete: session.mode === 'qa' ? undefined : onComplete });

  // 挂载时从 DB 加载历史（异步，不用 initialMessages）
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const loadedConversationId = session.conversationId;
    if (!loadedConversationId) return;
    let cancelled = false;
    api.listConversationMessages(loadedConversationId)
      .then((msgs) => {
        if (cancelled) return;
        // 竞态守卫：加载期间会话被 clear（conversationId 置 null）或指向新会话 → 丢弃迟到结果
        const cur = kbChatSessionsStore.getSessions().find((s) => s.id === session.id);
        if (!cur || cur.conversationId !== loadedConversationId) return;
        chat.setMessages(msgs.map(toChatMessage), loadedConversationId);
        const firstUser = msgs.find((m) => m.role === 'user');
        if (firstUser) {
          kbChatSessionsStore.updateSession(session.id, { title: firstUser.content.slice(0, 24) });
        }
      })
      .catch(() => { if (!cancelled) onLoadError?.(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // running 上报（驱动 wiki 互斥判断 + 关闭确认）
  useEffect(() => { onRunningChange(session.id, chat.isRunning); }, [chat.isRunning, session.id, onRunningChange]);

  // api 注册：send/clear 通过 ref 转发到最新 chat 方法，api 对象稳定
  const sendRef = useRef(chat.send); sendRef.current = chat.send;
  const setMessagesRef = useRef(chat.setMessages); setMessagesRef.current = chat.setMessages;
  const cancelRef = useRef(chat.cancel); cancelRef.current = chat.cancel;
  const resetRef = useRef(chat.reset); resetRef.current = chat.reset;
  const apiObj = useMemo<KbChatSessionApi>(() => ({
    send: (text) => sendRef.current(text),
    clear: () => {
      setMessagesRef.current([], null);
      kbChatSessionsStore.updateSession(session.id, { conversationId: null });
    },
    cancel: () => cancelRef.current(),
  }), [session.id]);
  useEffect(() => {
    registerApi(session.id, apiObj);
    return () => unregisterApi(session.id);
  }, [session.id, apiObj, registerApi, unregisterApi]);

  // 卸载时关闭 SSE（不 cancel run —— 后台任务继续跑，仅断开订阅，防 EventSource 泄漏/卸载后 setState）
  useEffect(() => () => { resetRef.current(); }, []);

  // 消息更新时滚到底部（照搬旧 KbChatPanel）
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.content]);

  const handleSend = useCallback((text: string, fileRefs?: FileRef[], pastedImages?: PastedImage[]) => {
    const prefix = buildAttachmentPrefix(fileRefs ?? [], pastedImages ?? []);
    let message = text;
    if (prefix) message = `${prefix}\n\n${message || ''}`;
    if (selectedText) {
      message = `${t('kb.fileChatContextPrefix')}\n> ${selectedText}\n\n${message}`;
      onSelectedTextConsumed?.();
    }
    const isFirstTurn = chat.conversationId == null;
    const wrapped = session.mode === 'qa' && isFirstTurn ? WIKI_QUERY_TRIGGER(message) : message;
    sendRef.current(wrapped);
  }, [selectedText, onSelectedTextConsumed, t, session.mode, chat.conversationId]);

  const contextLabel =
    session.mode === 'qa' ? t('kb.askButton')
    : session.mode === 'build' ? t('kb.chatContextBuildWiki')
    : session.mode === 'lint' ? t('kb.chatContextLintWiki')
    : t('kb.askButton');

  const initialFileRefs: FileRef[] =
    session.mode === 'qa' && session.filePath && session.vaultId
      ? [{ vaultId: session.vaultId, filePath: session.filePath }]
      : [];

  const lastAssistantId = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m && m.role === 'assistant') return m.id;
    }
    return null;
  })();

  return (
    <div className="file-chat-session" style={{ display: active ? undefined : 'none' }} data-testid="kb-chat-session">
      <div className="file-chat-messages">
        {chat.messages.length === 0 ? (
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
        ) : (
          <>
            {chat.messages.map((msg) => {
              if (msg.role === 'user') return <UserMessage key={msg.id} message={msg} />;
              if (msg.role === 'assistant') {
                return (
                  <AssistantMessage
                    key={msg.id}
                    message={msg}
                    isLast={msg.id === lastAssistantId}
                    onAnswerToolUse={async (toolUseId, content) => { await chat.submitToolResult(toolUseId, content); }}
                    onSubmitForm={(text) => sendRef.current(text)}
                  />
                );
              }
              if (msg.role === 'error') return <div key={msg.id} className="msg error">{msg.content}</div>;
              return null;
            })}
            <div ref={bottomRef} />
          </>
        )}
      </div>
      <ActivityTree activity={chat.activity ?? null} />
      <div className="file-chat-input">
        <ChatComposer
          key={session.id}
          composerKey={`kb:${session.id}`}
          isRunning={chat.isRunning}
          onSend={handleSend}
          onCancel={chat.cancel}
          initialFileRefs={initialFileRefs}
          onOpenConversation={onOpenConversation}
        />
      </div>
    </div>
  );
}
