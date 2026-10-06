import type { Page } from '@playwright/test';

/**
 * 低帧率复现开关（默认关，CI 不受影响）。
 *
 * 用途：d3-force 的 alpha 每渲染帧衰减一次，约 300 帧才到 alphaMin（引擎据此触发
 * 「收敛后取景」）。本地 120Hz 屏 ≈ 2.6s 就跑完，CI 上软件渲染（SwiftShader）帧率
 * 低得多，同样 300 帧的墙钟时间可以是 10s+。任何用固定 sleep 等「收敛/取景」的断言
 * 都会在本地绿、CI 红。
 *
 * 用法：`MOLIO_E2E_SLOW_FPS=20 npx playwright test graph-camera.spec.ts`
 * —— 把 rAF 限到 20fps，在本地复现 CI 的时序（graph-camera 两个用例即由此定案：
 * 低帧率下「固定等 4s」在取景发生前就断言，vpDiff 恰好为 0）。
 */
export async function throttleFrameRateIfRequested(page: Page): Promise<void> {
  const fps = Number(process.env.MOLIO_E2E_SLOW_FPS ?? 0);
  if (!Number.isFinite(fps) || fps <= 0) return;
  await page.addInitScript(`(() => {
    const orig = window.requestAnimationFrame.bind(window);
    const gap = ${Math.round(1000 / fps)};
    window.requestAnimationFrame = (cb) => orig((t) => setTimeout(() => cb(t), gap));
  })();`);
}
