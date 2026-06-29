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
  /** 问答模式：reset 线程 + 设 mode='qa'，不发送（等用户输入）。 */
  openQa: () => void;
  /** wiki 模式：reset 线程 + 设 mode + 自动发送 skill 提示词（一键开干）。 */
  openWikiOp: (type: 'build' | 'lint') => void;
  /** ingest 模式：reset 线程 + 设 mode='ingest' + 自动发送 ingest 提示词。 */
  openIngest: (filePath: string) => void;
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
    if (chat.isRunning) chat.cancel();
    conversationIdRef.current = null;
    setMode(null);
    chat.reset();
  }, [chat]);

  const openQa = useCallback(() => {
    reset();
    setMode('qa');
  }, [reset]);

  const openWikiOp = useCallback((type: 'build' | 'lint') => {
    reset();
    setMode(type);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_PROMPTS[type]);
    }, 50);
  }, [reset]);

  const openIngest = useCallback((filePath: string) => {
    reset();
    setMode('ingest');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_INGEST_PROMPT(filePath));
    }, 50);
  }, [reset]);

  const close = useCallback(() => {
    reset();
  }, [reset]);

  return {
    mode,
    messages: chat.messages,
    isRunning: chat.isRunning,
    openQa,
    openWikiOp,
    openIngest,
    send: chat.send,
    cancel: chat.cancel,
    submitToolResult: chat.submitToolResult,
    close,
  };
}
