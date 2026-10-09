// apps/web/src/stores/formSwitchStore.ts
//
// 「全屏态 ⇄ 局部显示（停靠侧边栏）」形态交接所需的一次性意图。
//
// 交接的几何**由到达的那一端自己驱动**，不做任何预测 —— 这是被实测逼出来的结论：
// 面板的形态是**按页记忆**的（`dockByPage`），悬浮态的自由位置与尺寸也持久化，
// 于是「进全屏的那一刻在来源页量一个矩形，出去时按它收拢」必然错位
// （实测同一面板在 /knowledge 是 `0,780,500,720` 停靠满高、在 /history 是 `72,756,500,624` 悬浮），
// 表现为「切回局部时位置每次不稳定」。
//
// 现在两端都是面板自己：宽度从自己的宽拉到内容区宽（进全屏）、或反向收窄（出全屏）。
// 宽度是面板自己的属性，不需要预测任何东西。

/**
 * 形态交接的时长（**必须与 CSS 同步**；CSS 读不到 TS 常量，改一边要改另一边）。
 *
 * - 进全屏 320ms：面板宽度从自身拉到内容区宽。位移量很大（面板宽 → 整页宽），
 *   太短会「瞬间到位」读不出过程；曲线用缓入缓出（0.4,0,0.2,1），
 *   而非面板开合那条起步极快的 (0.16,1,0.3,1) —— 后者在 46% 时间点就走完 95% 距离。
 * - 出全屏 320ms：反向收窄，播完才导航。
 */
export const FORM_SWITCH_ENTER_MS = 320;
export const FORM_SWITCH_EXIT_MS = 320;

/**
 * 置位时刻。用**时间戳短窗口**而不是「消费即清除」的布尔量：
 * React StrictMode 下组件会双渲染，`useState` 的惰性初始化器因此可能被调用两次 ——
 * 若首次就清掉标记，第二次读到的会是 false，动画在生产（非 StrictMode）与开发下表现不一致。
 */
const IDEMPOTENT_WINDOW_MS = 1_000;
let requestedAt = 0;
let requestedFor: string | null = null;

/**
 * 「本面板正从全屏态降级到局部」的一次性意图。
 *
 * 由 `App` 在**离开 `/chat`** 时置位（导航栏切页、剪藏协议落点、浏览器后退…全走这条），
 * 面板在 page 变化时消费：落到**停靠**形态（不遮挡）并播「从内容区宽收窄成侧边栏」。
 *
 * 为什么必须落停靠：浮动态是浮在内容上的，实测会遮住 settings 的更新卡链接、
 * resources 的搜索框与分类、history 的行操作。停靠配 `.entry-main` 的让位才是真的不遮挡。
 * 只覆盖这一页的形态记忆，用户之后自己拖成悬浮仍会被记住（用户偏好规则）。
 */
export function requestDegradeToDock(page: string): void {
  requestedAt = Date.now();
  requestedFor = page;
}

/**
 * 面板在 page 变化时判断是否该降级。
 *
 * **幂等读取，不做「消费即清除」**：React StrictMode 会双调用 effect，若第一次就读掉，
 * 第二次会走回「按页记忆」的分支、把刚落的停靠改回去（开发与生产表现不一致）。
 * 按页面寻址顺带保证「之后无关的 page 变化」不会被误当成降级。
 */
export function shouldDegradeToDock(page: string): boolean {
  return requestedFor === page && Date.now() - requestedAt < IDEMPOTENT_WINDOW_MS;
}
