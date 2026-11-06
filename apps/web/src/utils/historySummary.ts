/**
 * 历史列表摘要清洗。
 *
 * 会话最后一条消息若是题卡，摘要不该直接吐裸 JSON（真实库有 13 个会话这样）——
 * 剥掉题卡围栏，只留给人看的文字。
 */

import { stripQuizFences } from '@molio/contracts';

/**
 * 取一条消息的摘要文本：剥掉题卡围栏后取首个非空行。
 *
 * 全是题卡时返回空串——调用方据此显示「题卡」占位而不是空白。
 */
export function summarizeForHistory(content: string): string {
  if (!content) return '';
  const stripped = stripQuizFences(content);
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
