// apps/web/src/stores/formSwitchStore.ts
//
// 「全屏 ⇄ 悬浮」形态切换的一次性意图标记。
//
// 为什么需要它：`/chat` 的 shell 只在**用户点了面板头部的「全屏」**时才该播入场过渡。
// 冷启动、深链直开 `/chat`、从导航栏或历史页进 `/chat` 都不该播 —— 那些动作回答不了
// 任何用户手势，给它们加过渡就只是装饰（而装饰性入场正是「一眼 AI」的典型特征）。
// 两种到达方式在路由层面无法区分（都是「挂载 /chat」），所以由触发方显式置位。

/**
 * 形态过渡的时长常量（**必须与 CSS 同步**；CSS 无法读 TS 常量，改一边就要改另一边）。
 *
 * - 离开：160ms —— 沿用面板既有的收起曲线与时长（`cubic-bezier(0.55,0.06,0.68,0.19)`）。
 * - 进入：200ms —— 沿用面板既有的开启动画（`cubic-bezier(0.16,1,0.3,1)`）。
 */
export const FORM_SWITCH_EXIT_MS = 160;
export const FORM_SWITCH_ENTER_MS = 200;

/**
 * 置位时刻。用**时间戳短窗口**而不是「消费即清除」的布尔量：
 * React StrictMode 下组件会双渲染，`useState` 的惰性初始化器因此可能被调用两次 ——
 * 若首次就清掉标记，第二次读到的会是 false，动画在生产（非 StrictMode）与开发下表现不一致。
 * 短窗口幂等读取没有这个问题，且会自行过期，不留状态。
 */
let markedAt = 0;
const IDEMPOTENT_WINDOW_MS = 1_000;

/** 面板头部「全屏」按钮触发时调用。 */
export function markFormSwitchToFullscreen(): void {
  markedAt = Date.now();
}

/** `/chat` 的 shell 在挂载时读取；幂等（可安全重复调用）。 */
export function isFormSwitchToFullscreen(): boolean {
  return Date.now() - markedAt < IDEMPOTENT_WINDOW_MS;
}
