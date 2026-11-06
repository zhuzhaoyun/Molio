/**
 * dsh 工具共享出口约定（对齐 @molio/cli MCP 版）：
 * - 成功 → canonical value 为 daemon 返回的 JSON 数据，render 成单个 text
 *   ContentBlock（JSON.stringify，方便模型解析）；
 * - 失败 → execute 抛出带可读中文消息的 Error，dsh 管线归一化为 isError。
 *   DaemonError 先经 errorMessage 映射成与 CLI/MCP 一致的文案再抛。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { errorMessage } from '../errors.js';

/** canonical value → 模型可见的 JSON 文本块。 */
export function renderJson(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * daemon 响应（HTTP JSON）→ JsonValue 的显式收窄。接口类型没有 string 索引
 * 签名，直接返回会被 InferValue<'json'> 拒绝；数据本身来自 res.json()，
 * 天然是 lossless JSON，此断言是安全的。
 */
export function json(value: unknown): JsonValue {
  return value as JsonValue;
}

/**
 * execute 包装：把 DaemonError 等内部异常换成可读中文消息的普通 Error 再抛，
 * 保证模型看到的失败原因可操作（与 MCP runTool 的语义一致，只是出口从
 * isError 字段换成 dsh 的异常归一化）。
 */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}
