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
  /** 问答：只切 mode（预载 @当前文档），不 reset、不 cancel、不中断在跑的 run。 */
  openQa: () => void;
  /** wiki：reset 线程 + 设 mode + 自动发送（中断在跑的 run，一键开干）。 */
  openWikiOp: (type: 'build' | 'lint') => void;
  /** wiki 排队：不 reset、不 cancel，直接 send 提示词——走 useChatCore 的多轮
   *  sendMessage 路径，写入运行中 agent 的 stdin（Claude Code 等原生队列），
   *  agent 处理完当前轮再处理这条。Pattern B（stdin 已关）会回退到 createRun。 */
  queueWikiOp: (type: 'build' | 'lint') => void;
  /** ingest：reset + 自动发送（中断）。 */
  openIngest: (filePath: string) => void;
  /** ingest 排队：同 queueWikiOp，写入运行中 agent 的 stdin。 */
  queueIngest: (filePath: string) => void;
  send: (text: string) => void;
  cancel: () => void;
  submitToolResult: (toolUseId: string, content: string) => Promise<void>;
  /** 关面板：取消在跑的 run + reset。 */
  close: () => void;
}

export function useKbChat(opts: UseKbChatOptions): KbChatState {
  const { agentId, vaultPath, onComplete } = opts;
  const conversationIdRef = useRef<string | null>(null);
  const [mode, setMode] = useState<KbChatMode | null>(null);

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

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const reset = useCallback(() => {
    // Clear any pending wiki auto-send timer — otherwise switching to qa
    // (or closing) within 50ms of openWikiOp/openIngest would fire the wiki
    // prompt into the new mode's conversation.
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (chat.isRunning) chat.cancel();
    conversationIdRef.current = null;
    setMode(null);
    chat.reset();
  }, [chat]);

  const openQa = useCallback(() => {
    // 问答只激活 + 预载 @当前文档（mode='qa' 触发面板 seeding）。
    // 不 reset、不 cancel —— 不打断在跑的 run；用户 Enter 发送时走正常 send
    // 路径（有 run 在跑就多轮 follow-up，没就新建）。
    setMode('qa');
  }, []);

  const openWikiOp = useCallback((type: 'build' | 'lint') => {
    reset();
    setMode(type);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_PROMPTS[type]);
    }, 50);
  }, [reset]);

  const queueWikiOp = useCallback((type: 'build' | 'lint') => {
    // 排队：直接 send，走 useChatCore 多轮 sendMessage → agent stdin 队列。
    // 不 reset、不 cancel、不改 mode（当前任务仍在跑，label 不动）。
    chatRef.current.send(WIKI_PROMPTS[type]);
  }, []);

  const openIngest = useCallback((filePath: string) => {
    reset();
    setMode('ingest');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_INGEST_PROMPT(filePath));
    }, 50);
  }, [reset]);

  const queueIngest = useCallback((filePath: string) => {
    chatRef.current.send(WIKI_INGEST_PROMPT(filePath));
  }, []);

  const close = useCallback(() => {
    reset();
  }, [reset]);

  return {
    mode,
    messages: chat.messages,
    isRunning: chat.isRunning,
    openQa,
    openWikiOp,
    queueWikiOp,
    openIngest,
    queueIngest,
    send: chat.send,
    cancel: chat.cancel,
    submitToolResult: chat.submitToolResult,
    close,
  };
}
