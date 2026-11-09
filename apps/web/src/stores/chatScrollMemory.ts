/**
 * 会话滚动记忆 —— 按 conversationId 记住消息区的滚动位置与贴底状态。
 *
 * 语义（2026-11-09 拍板）：
 * - 记忆存在 ⇄ 标签还开着 ⇄ 切回（切标签 / 切表面形态）恢复到切换前位置；
 * - 标签关闭即删记忆 ⇄ 从历史重开贴底（新会话无记录也贴底）。
 *
 * 配套规则（ChatSessionView 侧）：
 * - 写入是**持续**的（每次 scroll 事件），不依赖「切走那一刻保存」——切走瞬间
 *   DOM 可能已经换人，那时读到的 scrollTop 不可信（同 useScrollMemory 约束 1）；
 * - 容器隐藏（display:none / clientHeight 0）时不得写入——boxless 元素读到的
 *   scrollTop 恒为 0，会把记忆污染成顶部。
 *
 * 进程内记忆，不持久化：跨重启恢复旧位置的风险高于收益（同 useScrollMemory）。
 */

export interface ChatScrollEntry {
  /** 滚动坐标（scrollTop）。 */
  top: number;
  /** 是否处于贴底跟随态——恢复时 pinned=true 走「贴新底」而不是回放旧坐标。 */
  pinned: boolean;
}

/** 记忆条数上限（近似 LRU）：标签上限 10/库，但同一标签可经历史下拉换绑多条会话，封顶防无界增长。 */
export const MAX_CHAT_SCROLL_ENTRIES = 100;

// Map 保持插入序；先删后写使「最近写入/读取」的条目沉底，淘汰时弹头部。
const memory = new Map<string, ChatScrollEntry>();

export function rememberChatScroll(
  conversationId: string | null | undefined,
  entry: ChatScrollEntry,
): void {
  if (!conversationId) return;
  memory.delete(conversationId);
  memory.set(conversationId, { top: entry.top, pinned: entry.pinned });
  for (const oldest of memory.keys()) {
    if (memory.size <= MAX_CHAT_SCROLL_ENTRIES) break;
    memory.delete(oldest);
  }
}

export function recallChatScroll(conversationId: string): ChatScrollEntry | null {
  const entry = memory.get(conversationId);
  if (!entry) return null;
  // 读取也算「新鲜」：刷新插入序，让 LRU 淘汰真正按访问时间走。
  memory.delete(conversationId);
  memory.set(conversationId, entry);
  return entry;
}

export function forgetChatScroll(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  memory.delete(conversationId);
}
