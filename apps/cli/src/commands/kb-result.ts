/**
 * molio kb result <runId> — 查询异步问答结果。
 * 默认单次查询（非终态时打印状态退出 0，外部 agent 可自行决定重试）；
 * --wait 时 2s 间隔轮询到终态或 --timeout（默认 120s，超时退出码 7）。
 * 取答路径 = GET run 状态 + 会话消息（SQLite 持久化），不依赖 SSE 回放缓冲。
 */
import { pollAsk, waitAsk, type AskPollResult } from '../ask-service.js';
import { CliError } from '../errors.js';
import { EXIT_OK, EXIT_RUN_FAILED } from '../exit-codes.js';
import { errLog, out, outJson } from '../output.js';
import type { CmdContext } from './types.js';
import { DEFAULT_ASK_TIMEOUT_SEC } from './kb-ask.js';

export async function kbResultCmd(
  ctx: CmdContext,
  opts: { runId: string; wait?: boolean; timeoutSec?: number },
): Promise<number> {
  const result = opts.wait
    ? await waitAsk(ctx.client, opts.runId, {
        timeoutMs: (opts.timeoutSec ?? DEFAULT_ASK_TIMEOUT_SEC) * 1000,
      })
    : await pollAsk(ctx.client, opts.runId);
  return printResult(ctx, result);
}

function printResult(ctx: CmdContext, result: AskPollResult): number {
  if (ctx.json) {
    outJson(result);
    if (result.status === 'failed' || result.status === 'canceled') return EXIT_RUN_FAILED;
    return EXIT_OK;
  }
  switch (result.status) {
    case 'succeeded':
      if (result.answer) out(result.answer);
      else errLog('run 已成功，但没有找到 assistant 回复内容');
      return EXIT_OK;
    case 'failed':
    case 'canceled':
      throw new CliError(EXIT_RUN_FAILED, result.error ?? `run ${result.status}`);
    default:
      errLog(`run 仍在执行（${result.status}）。稍后重试，或加 --wait 阻塞等待`);
      out(result.status);
      return EXIT_OK;
  }
}
