/**
 * 聊天消息区的「贴底跟随」判定（stick-to-bottom）。
 *
 * ChatSessionView 的滚动规则：用户贴底（距底 ≤ 阈值）时内容长高自动跟滚到最新；
 * 用户上翻阅读即脱离跟随，不再被强制拽回底部。
 */
export const PIN_THRESHOLD_PX = 80;

/** 距底是否在阈值内（content 不足一屏时视为贴底）。 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
