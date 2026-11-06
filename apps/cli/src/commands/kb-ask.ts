/**
 * molio kb ask <问题> — 基于知识库的 AI 问答。
 * 同步（默认）：订阅 SSE 实时流式打印，终态确认后收尾。
 * --async：只发起 run 秒回 {runId, conversationId}，用 `kb result` 取答。
 * --timeout：秒，默认 120（AI run 可能较长；超时退出码 7，run 仍在后台跑）。
 */
import { startAsk, streamAsk } from '../ask-service.js';
import { CliError } from '../errors.js';
import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js';
import { errLog, out, outJson, outRaw } from '../output.js';
import type { CmdContext } from './types.js';

export const DEFAULT_ASK_TIMEOUT_SEC = 120;

export async function kbAskCmd(
  ctx: CmdContext,
  opts: {
    question: string;
    vault?: string;
    agent?: string;
    timeoutSec?: number;
    async?: boolean;
  },
): Promise<number> {
  const start = await startAsk(ctx.client, {
    question: opts.question,
    vaultArg: opts.vault,
    agentArg: opts.agent,
  });

  if (opts.async) {
    if (ctx.json) {
      outJson({ runId: start.runId, conversationId: start.conversationId ?? null });
    } else {
      out(start.runId);
      errLog(
        `已发起问答（知识库「${start.vaultName}」，runtime ${start.agentId}）。取结果: molio kb result ${start.runId} --wait`,
      );
    }
    return EXIT_OK;
  }

  let streamedAny = false;
  const result = await streamAsk(ctx.client, start, {
    timeoutMs: (opts.timeoutSec ?? DEFAULT_ASK_TIMEOUT_SEC) * 1000,
    onDelta: ctx.json
      ? undefined
      : (delta) => {
          streamedAny = true;
          outRaw(delta);
        },
    onErrorEvent: (message) => errLog(`[run 错误事件] ${message}`),
  });

  if (ctx.json) {
    outJson({
      runId: start.runId,
      conversationId: start.conversationId ?? null,
      status: result.status,
      answer: result.answer,
    });
    return EXIT_OK;
  }
  // 流式增量已实时打印；仅当 SSE 没流出任何文本（回退消息兜底）时补印答案
  if (!streamedAny) {
    if (result.answer) out(result.answer);
    else throw new CliError(EXIT_USAGE, 'run 成功但没有产出任何回复内容');
  } else {
    // 流式输出不带结尾换行，补一个
    out();
  }
  return EXIT_OK;
}
