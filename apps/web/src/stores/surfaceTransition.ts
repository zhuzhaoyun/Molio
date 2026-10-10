// apps/web/src/stores/surfaceTransition.ts
//
// 「同一个表面」形变：对话面板（停靠/悬浮）、/chat 全屏 shell、右下角悬浮按钮是
// 同一块对话表面的不同形态。状态切换包进一次 document.startViewTransition，
// 浏览器实测前后两个真实矩形，GPU 合成地做几何形变 + 内容交叉淡化。
//
// **名字只在过渡期间存在**：view-transition-name 由本模块在过渡前后手动挂/摘，
// 而不是常驻 CSS —— Chromium 实测（2026-10-09）：VT 结束后名字若还留在元素上，
// 该元素的**命中测试会被跳过**（elementFromPoint 直接打到 <html>，拖拽/点击全哑）。
// 两端挂名时机：startViewTransition 抓旧快照前挂「旧表面」；update 完成后、
// 抓新快照前挂「新表面」；finished 后全部摘掉。
//
// 只在**手势路径**调用（按钮点击）；浏览器后退 / molio:// 深链 / 冷启动不包 ——
// 动效回答手势，非手势路径瞬间落位。形态落位的正确性由面板渲染期推导保证
// （见 KbChatSessionsPanel 的 prevPageRef 推导），与本模块无关。
import { flushSync } from 'react-dom';

const SURFACE_NAME = 'kb-chat-surface';

type DocumentWithVT = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => unknown;
};

/** 当前可见的对话表面（面板展开 > 全屏 shell；按钮**不是**表面形态——
 *  它是启动器：52px 的商标标被 VT 放大到整页是实测被否的突兀效果，
 *  按钮开合走自己的 CSS 升起/淡出语言）。 */
function surfaceElement(): HTMLElement | null {
  const panel = document.querySelector<HTMLElement>('[data-testid="kb-chat-panel"]');
  if (panel && !panel.classList.contains('floating-chat-panel--closed')) return panel;
  return document.querySelector<HTMLElement>('.home-page.chat-active');
}

function nameSurface(): void {
  surfaceElement()?.style.setProperty('view-transition-name', SURFACE_NAME);
}

function clearSurfaceNames(): void {
  for (const el of document.querySelectorAll<HTMLElement>(
    '[data-testid="kb-chat-panel"], .home-page.chat-active',
  )) {
    el.style.removeProperty('view-transition-name');
  }
}

/** 等「到达端」真实挂载：/chat 的 HomePage 是 React.lazy，navigate 提交后 chunk
 *  还要异步解析——不等它，新快照抓不到命名的表面 → 形变组不存在 → VT 瞬间空转
 *  （2026-10-10「进全屏没有动画」的根因；出全屏没事是因为面板常驻非懒加载）。
 *  rAF 轮询 + 250ms 兜底：万一到达端永远不来，也不能把页面冻在旧快照上。 */
function nextSurfaceReady(timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (surfaceElement() || Date.now() - t0 > timeoutMs) return resolve();
      // 不能用 rAF：VT 更新阶段渲染被挂起，rAF 停跳会死锁到超时；定时器不受影响
      setTimeout(tick, 16);
    };
    tick();
  });
}

function surfaceTransitionAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as DocumentWithVT;
  if (typeof doc.startViewTransition !== 'function') return false;
  // 减少动态偏好：不做形变，状态直接落位（CSS 层另有一道 animation:none 兜底）。
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── 「到达端就绪」登记 ─────────────────────────────────────────────
// 浏览器后退（navigate(-1)）是异步 pop 导航：flushSync 里只换得了面板开关，
// 换页要等 popstate。VT 的新快照必须等真正换页后再抓 —— update 以 Promise 告知
// 「DOM 已到终态」，App 的路由 effect 到达时调 notifySurfaceSettled() 放行。
let settle: (() => void) | null = null;

/** 异步导航（navigate(-1)）的 update 用它拿到「已真正换页」的信号。
 *  带 400ms 兜底超时：万一导航失败/未落地，VT 也不能把页面冻在旧快照上。 */
export function surfaceSettled(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 400);
    settle = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** 路由变化落地后调用（App 的路由 effect）。放行正在等待到达端的 VT。 */
export function notifySurfaceSettled(): void {
  settle?.();
  settle = null;
}

/**
 * 把一次状态切换包成「同一个表面」的形变。调用点全部是事件处理器（flushSync 在
 * 生命周期里调用会被 React 警告）。`update` 内部用 flushSync 同步换 DOM；
 * 若导航是异步 pop（navigate(-1)），update 返回 `surfaceSettled()` 的 Promise。
 */
let running: { skipTransition: () => void } | null = null;

/** 手势要立即接管时打断进行中的形变（拖拽开始等）：动画跳过、名字即刻摘除，
 *  命中测试立刻恢复 —— 否则形变进行中的 ~300ms 里拖拽会打在快照层上失效。 */
export function skipSurfaceTransition(): void {
  running?.skipTransition();
  running = null;
}

// 形变进行中的**任意**点击都立即打断它：VT 的快照层在 top layer，动画期间
// 表面元素被置为 visibility:hidden、点击会穿到下层页面（实测 Chromium 144，
// pointer-events:none 对覆盖层无效）。用户在形变里点的意图就是「别动画了」——
// 捕获阶段拦住、立刻跳过，后续交互即刻恢复。代价是那一击本身不落到控件上
// （可接受：比冻结 300ms 强得多）。
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => { if (running) skipSurfaceTransition(); },
    { capture: true },
  );
}

export function withSurfaceTransition(update: () => void | Promise<void>): void {
  const doc = document as DocumentWithVT;
  if (!surfaceTransitionAvailable() || typeof doc.startViewTransition !== 'function') {
    void Promise.resolve(update());
    return;
  }
  nameSurface(); // 旧表面：抓旧快照前必须已在场
  const vt = doc.startViewTransition(async () => {
    await update();
    await nextSurfaceReady();
    nameSurface(); // 新表面：update 换完 DOM、抓新快照前
  }) as { finished: Promise<void>; skipTransition: () => void } | undefined;
  running = vt ?? null;
  // 结束即摘名（成功/跳过/失败都要）——常驻名字会弄哑命中测试（见文件头）。
  void Promise.resolve(vt?.finished).catch(() => {}).then(() => {
    if (running === (vt ?? null)) running = null;
    clearSurfaceNames();
  });
}

/** 同步形态的便捷包装：update 里自带 flushSync。 */
export function withSurfaceTransitionSync(update: () => void): void {
  withSurfaceTransition(() => {
    flushSync(update);
  });
}
