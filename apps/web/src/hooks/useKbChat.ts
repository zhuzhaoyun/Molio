// apps/web/src/hooks/useKbChat.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useChatCore, type CreateRunContext, type ChatMessage } from './useChatCore';

export type KbChatMode = 'qa' | 'build' | 'lint' | 'ingest';

const WIKI_PROMPTS: Record<'build' | 'lint', string> = {
  build: '用 wiki-build skill 开始构建 Wiki：扫描 vault 中所有源文件，构建结构化 wiki。',
  lint: '用 wiki-lint skill 检查 Wiki 健康状况：查孤立页/断链/frontmatter 缺失/内容矛盾等，生成 lint 报告。',
};

function WIKI_INGEST_PROMPT(filePath: string): string {
  return `用 wiki-ingest skill 把这个文件加入 Wiki：${filePath}`;
}

/** 排队中的操作（不立即发送，等当前 run 完成后 shift 执行）。 */
export interface QueuedOp {
  id: string;
  type: 'build' | 'lint' | 'ingest';
  /** ingest 专用。 */
  filePath?: string;
  prompt: string;
}

export interface UseKbChatOptions {
  agentId: string | null;
  vaultPath: string | null;
  /** Refresh tree after a wiki build run completes. */
  onComplete?: () => void;
}

export interface KbChatState {
  mode: KbChatMode | null;
  messages: ChatMessage[];
  isRunning: boolean;
  queuedOps: QueuedOp[];
  /** 问答：只切 mode（预载 @当前文档），不 reset、不 cancel、不中断。 */
  openQa: () => void;
  /** wiki 中断：cancel 当前 run + 切 mode + 50ms 后 send（续同一线程，不清消息）。 */
  openWikiOp: (type: 'build' | 'lint') => void;
  /** wiki 排队：push 到 queuedOps，不 send；当前 run 完成后 shift 执行。 */
  queueWikiOp: (type: 'build' | 'lint') => void;
  /** ingest 中断：同 openWikiOp。 */
  openIngest: (filePath: string) => void;
  /** ingest 排队：同 queueWikiOp。 */
  queueIngest: (filePath: string) => void;
  /** 从排队列表移除一项。 */
  cancelQueued: (id: string) => void;
  send: (text: string) => void;
  cancel: () => void;
  submitToolResult: (toolUseId: string, content: string) => Promise<void>;
  /** 关面板（隐藏）：cancel 在跑的 + 清排队 + 清 timer，不清 messages。 */
  close: () => void;
  /** 新对话：清一切（queuedOps + messages + mode + cancel）。 */
  reset: () => void;
}

export function useKbChat(opts: UseKbChatOptions): KbChatState {
  const { agentId, vaultPath, onComplete } = opts;
  const conversationIdRef = useRef<string | null>(null);
  const [mode, setMode] = useState<KbChatMode | null>(null);
  const [queuedOps, setQueuedOps] = useState<QueuedOp[]>([]);
  const idRef = useRef(0);

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
      conversationId: ctx.conversationId ?? conversationIdRef.current ?? undefined,
      history: contractHistory.length > 0 ? contractHistory : undefined,
    });
    if (result.conversationId) conversationIdRef.current = result.conversationId;
    return { runId: result.runId, conversationId: result.conversationId };
  }, [agentId, vaultPath]);

  const chat = useChatCore({ createRun, agentId, onComplete });

  const chatRef = useRef(chat);
  chatRef.current = chat;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRunningRef = useRef(false);

  // 卸载时清定时器
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // shift-on-complete：isRunning 由 true→false 时，执行排队首项（续线程）。
  // prevRunningRef 检测边沿，避免每次 render 重复触发。
  useEffect(() => {
    if (prevRunningRef.current && !chat.isRunning && queuedOps.length > 0) {
      const [first, ...rest] = queuedOps;
      setQueuedOps(rest);
      setMode(first.type);
      if (timerRef.current) clearTimeout(timerRef.current);
      // 50ms 让完成后的 state flush；send 走 createRun（续同一线程，带 history）。
      timerRef.current = setTimeout(() => {
        chatRef.current.send(first.prompt);
      }, 50);
    }
    prevRunningRef.current = chat.isRunning;
  }, [chat.isRunning, queuedOps]);

  // 新对话：清一切
  const reset = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setQueuedOps([]);
    if (chat.isRunning) chat.cancel();
    conversationIdRef.current = null;
    setMode(null);
    chat.reset();
  }, [chat]);

  const openQa = useCallback(() => {
    // 问答只激活 + 预载 @当前文档；不 reset、不 cancel、不中断。
    setMode('qa');
  }, []);

  const openWikiOp = useCallback((type: 'build' | 'lint') => {
    // 中断：cancel 当前 run（关 SSE + 杀后端）+ 切 mode + 50ms 后 send。
    // 不 reset、不清消息——续同一线程（createRun 带 history）。
    if (chat.isRunning) chat.cancel();
    setMode(type);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_PROMPTS[type]);
    }, 50);
  }, [chat]);

  const queueWikiOp = useCallback((type: 'build' | 'lint') => {
    // 排队：不 send，push 到 queuedOps；完成后 shift 执行。
    setQueuedOps((prev) => [...prev, {
      id: `q${++idRef.current}`,
      type,
      prompt: WIKI_PROMPTS[type],
    }]);
  }, []);

  const openIngest = useCallback((filePath: string) => {
    if (chat.isRunning) chat.cancel();
    setMode('ingest');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_INGEST_PROMPT(filePath));
    }, 50);
  }, [chat]);

  const queueIngest = useCallback((filePath: string) => {
    setQueuedOps((prev) => [...prev, {
      id: `q${++idRef.current}`,
      type: 'ingest',
      filePath,
      prompt: WIKI_INGEST_PROMPT(filePath),
    }]);
  }, []);

  const cancelQueued = useCallback((id: string) => {
    setQueuedOps((prev) => prev.filter((op) => op.id !== id));
  }, []);

  const close = useCallback(() => {
    // 隐藏：cancel 在跑的 + 清排队 + 清 timer；不清 messages（重开还在）。
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setQueuedOps([]);
    if (chat.isRunning) chat.cancel();
  }, [chat]);

  return {
    mode,
    messages: chat.messages,
    isRunning: chat.isRunning,
    queuedOps,
    openQa,
    openWikiOp,
    queueWikiOp,
    openIngest,
    queueIngest,
    cancelQueued,
    send: chat.send,
    cancel: chat.cancel,
    submitToolResult: chat.submitToolResult,
    close,
    reset,
  };
}
