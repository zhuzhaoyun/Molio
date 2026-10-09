// apps/web/src/stores/formSwitchStore.ts
//
// 「全屏 ⇄ 悬浮」形态切换的一次性意图标记。
//
// 为什么需要它：`/chat` 的 shell 只在**用户点了面板头部的「全屏」**时才该播入场过渡。
// 冷启动、深链直开 `/chat`、从导航栏或历史页进 `/chat` 都不该播 —— 那些动作回答不了
// 任何用户手势，给它们加过渡就只是装饰（而装饰性入场正是「一眼 AI」的典型特征）。
// 两种到达方式在路由层面无法区分（都是「挂载 /chat」），所以由触发方显式置位。

/**
 * 形态变形的时长常量（**必须与 CSS 同步**；CSS 无法读 TS 常量，改一边就要改另一边）。
 *
 * - 进入 320ms：从面板矩形长开成整页。比面板自身开合（200ms）长得多，是**有意的** ——
 *   这条要走完的大位移（面板宽度 → 整页）远超面板开合那 16px，用同样的短时长会「瞬间到位」，
 *   读不出「在长大」，两端就又像两个组件了。
 *   曲线也没沿用面板那条起步极快的（0.16,1,0.3,1）：它在 46% 时间点就走完 95% 距离，
 *   对大尺度变形等于没有过程。改用起步从容的 (0.4,0,0.2,1)（缓入缓出）：它在 37.5% 时间点约走 50%，过程才看得出来。
 * - 离开 220ms：缩回面板矩形；这段还要门住导航（播完才换页），所以比进入略短。
 */
export const FORM_SWITCH_ENTER_MS = 320;
export const FORM_SWITCH_EXIT_MS = 220;

/**
 * 置位时刻。用**时间戳短窗口**而不是「消费即清除」的布尔量：
 * React StrictMode 下组件会双渲染，`useState` 的惰性初始化器因此可能被调用两次 ——
 * 若首次就清掉标记，第二次读到的会是 false，动画在生产（非 StrictMode）与开发下表现不一致。
 * 短窗口幂等读取没有这个问题，且会自行过期，不留状态。
 */
let markedAt = 0;
const IDEMPOTENT_WINDOW_MS = 1_000;

/** 一个矩形（视口坐标系）。 */
export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * 形态变形的几何：面板矩形 + 面板所在的**内容盒**矩形（两者都在点击「全屏」时量）。
 *
 * 为什么必须带上内容盒：`clip-path: inset()` 的四边内缩是相对**元素自己的边框盒**算的，
 * 而 `/chat` shell 并不占满视口（左边被导航栏占掉）。只按视口算 inset 会让起止位置
 * 整体偏移一个导航栏的宽度 —— 那就恰好破坏了「两端同一个矩形」这个唯一的连贯性来源。
 *
 * 「进入」时机可以直接量（面板就在 DOM 里）；「离开」时量不到（面板在 `/chat` 上是
 * `return null`），所以复用「进入」时那一份 —— 全屏期间导航栏与面板几何都不变。
 */
let morphGeometry: { panel: Rect; container: Rect } | null = null;

/** 面板头部「全屏」按钮触发时调用，记下变形两端几何。 */
export function markFormSwitchToFullscreen(panel: Rect | null, container: Rect | null): void {
  markedAt = Date.now();
  morphGeometry = panel && container ? { panel, container } : null;
}

/** `/chat` 的 shell 在挂载时读取；幂等（可安全重复调用）。 */
export function isFormSwitchToFullscreen(): boolean {
  return Date.now() - markedAt < IDEMPOTENT_WINDOW_MS;
}

/**
 * 变形几何 → `clip-path: inset(...)` 字符串（相对内容盒）。
 * 圆角取面板的 12px —— 两端形状一致，才读得出「同一个容器开合」。
 */
export function morphClipInset(): string | null {
  if (!morphGeometry) return null;
  const { panel, container } = morphGeometry;
  const w = container.right - container.left;
  const h = container.bottom - container.top;
  const top = Math.max(0, panel.top - container.top);
  const left = Math.max(0, panel.left - container.left);
  const right = Math.max(0, w - (panel.right - container.left));
  const bottom = Math.max(0, h - (panel.bottom - container.top));
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${PANEL_RADIUS_PX}px)`;
}

/** 面板圆角（与 KbChatSessionsPanel.css 的 .floating-chat-panel border-radius 一致）。 */
export const PANEL_RADIUS_PX = 12;
