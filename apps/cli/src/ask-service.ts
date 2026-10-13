/**
 * AI 问答核心流程 — CLI（kb ask / kb result）与 MCP（kb_ask_start / kb_ask_poll）
 * 共用的唯一实现，两种出口只是薄壳。
 *
 * 关键约束（来自 WorkBuddy 连接器规范与 daemon 实现）：
 * - MCP 单次 tool 调用须 ≤30s → 问答拆为 start（秒回 runId）+ poll（单次查询，
 *   handler 内绝不轮询，由调用方 agent 重复调用）
 * - daemon SSE 事件缓冲消费者 drain 后即释放 → 迟到的 poll 不走 SSE 回放，
 *   用 GET run 状态 + GET conversation messages 取最终答案（持久化在 SQLite）
 * - cwd 必须精确等于 vault.path（daemon getVaultByPath 是 SQL 精确匹配）
 */
import type { RunStatus } from '@molio/contracts';
import {
  isTerminalStatus,
  lastAssistantText,
  turnCompleted,
  type DaemonClient,
} from './daemon-client.js';
import { CliError, toCliError, runNotFoundCtx } from './errors.js';
import {
  EXIT_DAEMON_UNREACHABLE,
  EXIT_RUN_FAILED,
  EXIT_TIMEOUT,
} from './exit-codes.js';
import { resolveAgentId, resolveVault } from './vault-resolver.js';

export interface AskStartResult {
  runId: string;
  conversationId?: string;
  vaultId: string;
  vaultName: string;
  agentId: string;
}

/** 发起问答 run（同步/异步/MCP start 共用第一步）。 */
export async function startAsk(
  client: DaemonClient,
  opts: { question: string; vaultArg?: string; agentArg?: string },
): Promise<AskStartResult> {
  const question = opts.question.trim();
  if (!question) {
    throw new CliError(EXIT_RUN_FAILED, '问题不能为空');
  }
  const vault = await resolveVault(client, opts.vaultArg);
  const agentId = await resolveAgentId(client, opts.agentArg);
  const res = await client.createRun({
    agentId,
    message: question,
    cwd: vault.path, // 精确 vault.path → runtime 在库目录加载上下文
  });
  return {
    runId: res.runId,
    conversationId: res.conversationId,
    vaultId: vault.id,
    vaultName: vault.name,
    agentId,
  };
}

export interface AskPollResult {
  runId: string;
  status: RunStatus;
  /** 终态 succeeded 时的最终答案（可能为 null：run 成功但无 assistant 消息）。 */
  answer?: string | null;
  /** 终态 failed/canceled 时的原因。 */
  error?: string;
}

/**
 * 单次查询问答结果 — 绝不阻塞轮询（MCP 30s 约束）。
 *
 * 完成判定 = 终态 **或** 回合完成（turnCompleted）。multiTurn agent（Claude Code）
 * turn_end 后 run 仍停在 'running' 直到 30min TTL，若只等终态则 poll 永远拿不到答案；
 * 因此 lastStopReason 一置位即视为完成、归一化 status 为 'succeeded'，并主动 cancel
 * 释放挂起进程（答案此刻已落库，cancel 幂等且不影响取答）。
 */
export async function pollAsk(client: DaemonClient, runId: string): Promise<AskPollResult> {
  const run = await toRun(client, runId);
  // 完成判定**优先于**失败/取消：multiTurn 回合完成后我们会主动 cancel 释放进程，
  // daemon 侧 cancel 不清 lastStopReason（实测 status=canceled 但 lastStopReason=end_turn
  // 仍在），故「已取消」的 run 若回合已完成，答案早已落库——幂等地报 succeeded + 答案，
  // 而不是把自家清理动作误报成失败。只有回合**未**完成的 failed/canceled 才是真失败。
  if (run.status === 'succeeded' || turnCompleted(run)) {
    let answer: string | null = null;
    if (run.conversationId) {
      try {
        const messages = await client.getMessages(run.conversationId);
        answer = lastAssistantText(messages);
      } catch {
        // 消息拉取失败不致命：answer 留空由调用方提示
      }
    }
    if (!isTerminalStatus(run.status)) {
      await client.cancelRun(runId); // 尽力而为，cancelRun 内部吞错不抛
    }
    return { runId, status: 'succeeded', answer };
  }
  // 真失败 / 真取消（回合未完成，无落库答案）
  if (run.status === 'failed' || run.status === 'canceled') {
    return {
      runId,
      status: run.status,
      error:
        run.error ??
        (run.status === 'canceled'
          ? 'run 已取消'
          : `run 失败（stopReason: ${run.lastStopReason ?? '未知'}）`),
    };
  }
  // 仍在进行
  return { runId, status: run.status };
}

async function toRun(client: DaemonClient, runId: string) {
  try {
    return await client.getRun(runId);
  } catch (err) {
    throw toCliError(err, runNotFoundCtx);
  }
}

export interface StreamAskOptions {
  timeoutMs: number;
  /** text_delta 增量回调（CLI 同步模式实时打印；--json 时不传）。 */
  onDelta?: (delta: string) => void;
  /** error 事件回调（打 stderr，不中断流）。 */
  onErrorEvent?: (message: string) => void;
}

export interface StreamAskResult {
  answer: string;
  status: RunStatus;
}

/**
 * 同步模式：订阅 SSE 聚合 text_delta，看到**完成信号**即 break 收尾返回最终答案。
 *
 * ⚠️ 完成信号既不是「流关闭」也不是「run 终态」：
 * - 真实 daemon 在 run 终止时**不关在线 SSE 流**（sse.ts 只对订阅时就已终态的 run
 *   立即关流；在线订阅靠 15s ping 长挂，只有客户端断开或 stall-close 才结束）。
 * - multiTurn agent（Claude Code）turn_end 后**进程不退出**，run 永远停在 'running'。
 * 因此以 SSE 的 `turn_end`（stopReason≠'tool_use'，daemon 自己的回合完成定义）或
 * `status:completed/failed/canceled` 事件为完成信号主动 break，再 GET run 收尾，并
 * 对仍挂着的 multiTurn run 主动 cancel 释放进程（否则每次 ask 泄漏一个常驻子进程）。
 *
 * - 完成 + 有聚合文本：直接返回；文本为空回退会话消息兜底
 * - failed/canceled：CliError(EXIT_RUN_FAILED)
 * - 超时（AbortSignal.timeout）：CliError(EXIT_TIMEOUT)
 * - 中途断连（daemon 重启等）：查一次 run —— 已完成照常取答，否则提示用 result 跟进
 *   （EXIT_DAEMON_UNREACHABLE）；404 → run 丢失（EXIT_RUN_FAILED）
 */
export async function streamAsk(
  client: DaemonClient,
  start: AskStartResult,
  opts: StreamAskOptions,
): Promise<StreamAskResult> {
  let aggregated = '';
  let sawComplete = false;
  let sawFailure: 'failed' | 'canceled' | null = null;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  try {
    for await (const envelope of client.runEvents(start.runId, { signal })) {
      const event = envelope.event;
      if (event.type === 'text_delta') {
        aggregated += event.delta;
        opts.onDelta?.(event.delta);
      } else if (event.type === 'error') {
        opts.onErrorEvent?.(event.message); // 打 stderr，不中断流
      } else if (event.type === 'turn_end') {
        // stopReason==='tool_use' 是回合内中间步（模型还要调工具），不算完成
        if (event.stopReason !== 'tool_use') {
          sawComplete = true;
          break;
        }
      } else if (event.type === 'status') {
        if (event.label === 'completed') {
          sawComplete = true;
          break;
        }
        if (event.label === 'failed' || event.label === 'canceled') {
          sawFailure = event.label;
          break;
        }
        // 'running' 等状态事件忽略
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || signal.aborted)) {
      throw new CliError(
        EXIT_TIMEOUT,
        `问答超时（${Math.round(opts.timeoutMs / 1000)}s）。run 仍在后台执行，可用 molio kb result ${start.runId} --wait 继续等待`,
      );
    }
    if (err instanceof CliError) throw err;
    // 非主动中止的流中断（daemon 重启等）：带着已聚合内容收尾
    return finalize(client, start, aggregated, sawComplete, sawFailure, err);
  }

  // 看到完成/失败信号而 break，或流自然 EOF（单轮 agent / fake daemon 关流）
  return finalize(client, start, aggregated, sawComplete, sawFailure);
}

/**
 * 收尾：GET run 判定成败、取答、对仍挂着的 multiTurn run 尽力 cancel 释放进程。
 * sawComplete/sawFailure 来自 SSE 完成信号；disconnectCause 非空表示流是异常中断的。
 */
async function finalize(
  client: DaemonClient,
  start: AskStartResult,
  aggregated: string,
  sawComplete: boolean,
  sawFailure: 'failed' | 'canceled' | null,
  disconnectCause?: unknown,
): Promise<StreamAskResult> {
  const run = await toRun(client, start.runId); // 404/不可达 → CliError

  // 成功**优先于**失败：完成信号 / 终态 succeeded / 回合完成（lastStopReason 置位）。
  // 回合完成后我们会主动 cancel，daemon 不清 lastStopReason，故即便 run 已是 canceled，
  // 只要回合完成过就照常取答（幂等），不把自家清理误报成失败。
  if (sawComplete || run.status === 'succeeded' || turnCompleted(run)) {
    let answer = aggregated;
    if (!answer.trim() && run.conversationId) {
      try {
        const messages = await client.getMessages(run.conversationId);
        answer = lastAssistantText(messages) ?? '';
      } catch {
        /* 消息拉取失败不致命，保留已聚合内容 */
      }
    }
    // multiTurn：run 未进终态，主动 cancel 释放挂起的 agent 进程（幂等，答案已落库）
    if (!isTerminalStatus(run.status)) {
      await client.cancelRun(start.runId);
    }
    return { answer, status: 'succeeded' };
  }

  // 失败：SSE status 事件或 run 终态（且回合未完成 → 无落库答案）
  if (sawFailure || run.status === 'failed' || run.status === 'canceled') {
    const st = run.status === 'failed' || run.status === 'canceled' ? run.status : sawFailure;
    throw new CliError(
      EXIT_RUN_FAILED,
      run.error ?? (st === 'canceled' ? 'run 已取消' : 'AI 问答失败'),
    );
  }

  // 既无完成信号也无终态：流中断 → 提示异步跟进
  if (disconnectCause) {
    throw new CliError(
      EXIT_DAEMON_UNREACHABLE,
      `与 daemon 的事件流中断（${disconnectCause instanceof Error ? disconnectCause.message : String(disconnectCause)}），run 仍在执行。可用 molio kb result ${start.runId} --wait 继续等待`,
    );
  }
  throw new CliError(
    EXIT_DAEMON_UNREACHABLE,
    `事件流已关闭但 run 仍为 ${run.status}，可用 molio kb result ${start.runId} --wait 继续等待`,
  );
}

/**
 * --wait 轮询（CLI `kb result --wait` 用；MCP 侧绝不使用）。
 * 2s 间隔轮询直到终态或超时。
 */
export async function waitAsk(
  client: DaemonClient,
  runId: string,
  opts: { timeoutMs: number; pollIntervalMs?: number; onPoll?: (r: AskPollResult) => void },
): Promise<AskPollResult> {
  const interval = opts.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await pollAsk(client, runId);
    opts.onPoll?.(result);
    if (isTerminalStatus(result.status)) return result;
    if (Date.now() + interval > deadline) {
      throw new CliError(
        EXIT_TIMEOUT,
        `等待超时（${Math.round(opts.timeoutMs / 1000)}s），run 仍为 ${result.status}。稍后可再次执行 molio kb result ${runId}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
