/**
 * MCP tool 共享出口约定：
 * - 成功 → content[0].text 为 JSON（结构化数据，方便 agent 解析）
 * - 失败 → isError:true + 可读中文消息（与 CLI stderr 同一套文案，daemonErrorMessage）
 * - handler 内部绝不轮询/长阻塞（WorkBuddy MCP 请求 30s 上限）；
 *   长任务（AI 问答）拆成 kb_ask_start / kb_ask_poll 由调用方 agent 轮询。
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CliError, daemonErrorMessage, isDaemonError } from '../../errors.js';

export function toolOk(data: unknown): CallToolResult {
  return toolText(JSON.stringify(data, null, 2));
}

export function toolText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function errorMessage(err: unknown): string {
  if (err instanceof CliError) return err.message;
  if (isDaemonError(err)) return daemonErrorMessage(err);
  return err instanceof Error ? err.message : String(err);
}

/** handler 包装：任何抛出 → isError + 中文消息，绝不让异常穿透 JSON-RPC 层。 */
export async function runTool(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return toolError(errorMessage(err));
  }
}
