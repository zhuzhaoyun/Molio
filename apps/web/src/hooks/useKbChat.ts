import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ActivityInfo } from '@molio/contracts';
import { useChatCore, type CreateRunContext, type ChatMessage } from './useChatCore';

export type KbChatMode = 'qa' | 'build' | 'lint' | 'ingest';

const WIKI_PROMPTS: Record<'build' | 'lint', string> = {
  build: '用 wiki-build skill 开始构建 Wiki：扫描 vault 中所有源文件，构建结构化 wiki。',
  lint: '用 wiki-lint skill 检查 Wiki 健康状况：查孤立页/断链/frontmatter 缺失/内容矛盾等，生成 lint 报告。',
};

function WIKI_INGEST_PROMPT(filePath: string, isDirectory = false): string {
  if (isDirectory) {
    return `用 wiki-ingest skill 把这个文件夹下的所有文件加入 Wiki：${filePath}（递归处理所有子文件夹和文件）`;
  }
  return `用 wiki-ingest skill 把这个文件加入 Wiki：${filePath}`;
}

/**
 * qa 模式确定性触发：KB 问答面板里用户输入的问题是知识库问题，包一层显式触发语，
 * 确保 agent 走 wiki-query skill 检索而非凭记忆作答。
 *
 * 只在会话首轮包裹（见 send）：后续多轮 follow-up（「再详细点」「继续」）的上下文
 * 里已经有首轮触发语 + agent 正在执行的 wiki-query 流程，每轮重复包裹只会让消息都
 * 顶着「（知识库问答：…）」前缀、污染对话历史。
 *
 * 这是主界面的双保险——vault 的 .claude/CLAUDE.md 还有一条常驻 wiki-query 规则
 * （skill-installer 注入）覆盖通用/微信场景；此处针对专用 KB 问答面板再加确定性触发。
 */
function WIKI_QUERY_TRIGGER(question: string): string {
  return `（知识库问答：请用 wiki-query skill，先读 wiki/INDEX.md 检索相关页面再回答，不要凭训练记忆作答）\n${question}`;
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
  /** Live background subagent/workflow activity (wiki build L1 等)。 */
  activity: ActivityInfo | null;
  /** 问答：只切 mode（预载 @当前文档），不 reset、不 cancel、不中断在跑的 run。 */
  openQa: () => void;
  /** wiki：reset 线程 + 设 mode + 自动发送（中断在跑的 run，一键开干）。 */
  openWikiOp: (type: 'build' | 'lint') => void;
  /** wiki 排队：不 reset、不 cancel，直接 send 提示词——走 useChatCore 的多轮
   *  sendMessage 路径，写入运行中 agent 的 stdin（Claude Code 等原生队列），
   *  agent 处理完当前轮再处理这条。Pattern B（stdin 已关）会回退到 createRun。 */
  queueWikiOp: (type: 'build' | 'lint') => void;
  /** ingest：reset + 自动发送（中断）。 */
  openIngest: (filePath: string, isDirectory?: boolean) => void;
  /** ingest 排队：同 queueWikiOp，写入运行中 agent 的 stdin。 */
  queueIngest: (filePath: string, isDirectory?: boolean) => void;
  send: (text: string) => void;
  cancel: () => void;
  submitToolResult: (toolUseId: string, content: string) => Promise<void>;
  /** 关面板：取消在跑的 run + reset。 */
  close: () => void;
}

export function useKbChat(opts: UseKbChatOptions): KbChatState {
  const { agentId, vaultPath, onComplete } = opts;
  const conversationIdRef = useRef<string | null>(null);
  // A conversation is bound to a vault (cwd). Switching vault must not continue
  // the previous vault's thread — reset the lineage so the next send starts fresh.
  useEffect(() => {
    conversationIdRef.current = null;
  }, [vaultPath]);
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

  // The conversation lineage also lives in useChatCore's state (state.conversationId),
  // which survives vault switches and is passed back in as ctx.conversationId on the
  // next createRun — the ref reset above alone would still leak the old vault's thread
  // (verified by the vault-switch E2E). Reset the whole chat core state so the new vault
  // truly starts a fresh conversation: messages cleared, conversationId + runId nulled,
  // SSE closed. (It does NOT cancel the daemon process — that is close()'s job; a leftover
  // run on an abandoned vault is the same behavior as closing the panel mid-run.)
  // chat.reset is stable (useCallback([]) chain), so this effect only fires on vaultPath
  // change, not every render.
  const chatReset = chat.reset;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A pending wiki auto-send (openWikiOp/openIngest fire within 50ms) must not
    // bleed into the new vault's fresh chat — clear it along with chat.reset().
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    chatReset();
  }, [vaultPath, chatReset]);

  const chatRef = useRef(chat);
  chatRef.current = chat;

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

  const openIngest = useCallback((filePath: string, isDirectory = false) => {
    reset();
    setMode('ingest');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      chatRef.current.send(WIKI_INGEST_PROMPT(filePath, isDirectory));
    }, 50);
  }, [reset]);

  const queueIngest = useCallback((filePath: string, isDirectory = false) => {
    chatRef.current.send(WIKI_INGEST_PROMPT(filePath, isDirectory));
  }, []);

  const close = useCallback(() => {
    reset();
  }, [reset]);

  // qa 模式：用户自由输入且必为知识库问题 → 包显式 wiki-query 触发语（确定性触发）。
  // 仅会话首轮包裹：conversationIdRef 在新会话（初始 / reset 后）为 null，首轮
  // createRun 成功后置位——之后发出的消息都是同一会话的多轮 follow-up，不再包裹。
  // 其它 mode（build/lint/ingest）的自动发送走各自 prompt，用户在这些 mode 手输的
  // 消息按原样发出，不改写。
  const send = useCallback((text: string) => {
    const isFirstTurn = conversationIdRef.current == null;
    chat.send(mode === 'qa' && isFirstTurn ? WIKI_QUERY_TRIGGER(text) : text);
  }, [chat, mode]);

  return {
    mode,
    messages: chat.messages,
    isRunning: chat.isRunning,
    activity: chat.activity,
    openQa,
    openWikiOp,
    queueWikiOp,
    openIngest,
    queueIngest,
    send,
    cancel: chat.cancel,
    submitToolResult: chat.submitToolResult,
    close,
  };
}
