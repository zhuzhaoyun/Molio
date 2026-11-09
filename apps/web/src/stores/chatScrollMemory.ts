/**
 * 会话滚动记忆 —— 按 conversationId 记住消息区的滚动位置与贴底状态。
 *
 * 语义（2026-11-09 拍板）：
 * - 记忆存在 ⇄ 标签还开着 ⇄ 切回（切标签 / 切表面形态）恢复到切换前位置；
 * - 标签关闭即删记忆 ⇄ 从历史重开贴底（新会话无记录也贴底）。
 *
 * **位置用「锚点」表达，不用绝对坐标**：全屏 ⇄ 面板宽度不同，消息重新折行后
 * 同一个 scrollTop 对应的可见内容会漂移（数值恢复到位、视觉上偏移）。锚点 =
 * 视口顶第一条消息的序号 + 它顶缘相对视口顶的偏移（px，被截断时为负），恢复时
 * 把同一条消息钉回同一视口位置——宽度无关；同宽布局下锚点恢复同样像素精确
 * （同布局同消息同偏移 = 同坐标），故统一走锚点，绝对 top 仅作锚点失效的兜底
 * （内容被编辑重发截断时序号可能对不上）。
 *
 * 配套规则（ChatSessionView 侧）：
 * - 写入是**持续**的（每次 scroll 事件），不依赖「切走那一刻保存」——切走瞬间
 *   DOM 可能已经换人，那时读到的 scrollTop 不可信（同 useScrollMemory 约束 1）；
 * - 容器隐藏（display:none / clientHeight 0）时不得写入——boxless 元素读到的
 *   scrollTop 恒为 0，会把记忆污染成顶部。
 *
 * 进程内记忆，不持久化：跨重启恢复旧位置的风险高于收益（同 useScrollMemory）。
 */

/** 视口顶锚点：第 index 条消息的顶缘在视口顶下方 offsetPx 处（被截断时为负）。 */
export interface ChatScrollAnchor {
  index: number;
  offsetPx: number;
}

export interface ChatScrollEntry {
  /** 是否处于贴底跟随态——恢复时 pinned=true 走「贴新底」而不是回放锚点。 */
  pinned: boolean;
  /** 绝对坐标兜底（锚点失效——消息被截断——时 clamp 使用）。 */
  top: number;
  /** 视口顶锚点；贴底或无法计算时为 null。 */
  anchor: ChatScrollAnchor | null;
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
  memory.set(conversationId, {
    pinned: entry.pinned,
    top: entry.top,
    anchor: entry.anchor ? { index: entry.anchor.index, offsetPx: entry.anchor.offsetPx } : null,
  });
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

/**
 * 从消息几何信息里找视口顶锚点：第一条**有效可见**（底缘超过视口顶
 * `scrollTop + minVisiblePx`）的消息。残条不算——只露出几像素的消息没有阅读
 * 意义，钉它会在宽度不同的表面间翻转（面板里同一条消息折行变高，露出的残条
 * 从 16px 变 40px，「视口顶第一条」的观感就从它漂到下一条）。全都不够可见或
 * 列表为空 → null，恢复方走兜底。
 *
 * 纯函数：入参是调用方从 DOM 量好的 top/height 平行数组（越界外的细节不进这里，
 * 可在 node:test 里穷举）。
 */
export const ANCHOR_MIN_VISIBLE_PX = 24;

export function findVisibleAnchor(
  tops: number[],
  heights: number[],
  scrollTop: number,
  minVisiblePx: number = ANCHOR_MIN_VISIBLE_PX,
): ChatScrollAnchor | null {
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! + heights[i]! > scrollTop + minVisiblePx) {
      return { index: i, offsetPx: tops[i]! - scrollTop };
    }
  }
  return null;
}

/** 锚点 → 目标 scrollTop：第 index 条消息的顶缘坐标 − 它应处的新视口偏移。 */
export function applyAnchorOffset(messageTop: number, anchor: ChatScrollAnchor): number {
  return messageTop - anchor.offsetPx;
}
