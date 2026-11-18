#!/usr/bin/env node
/**
 * graph-perf-probe — 台式机测量（浏览器侧）：图谱收敛墙钟 + 空闲/缩放帧统计 + 空闲渲染计数。
 *
 * 用法: node scripts/graph-perf-probe.mjs --vault <名称或路径子串> [--web http://localhost:5173] [--daemon http://localhost:3100]
 *
 * 前置：
 *   - pnpm dev（daemon :3100 + web :5173）已启动；库已注册
 *   - 本机装有依赖（pnpm install 过）；Playwright 从 apps/web 的依赖里解析
 *   - 有头模式 + GPU（真实渲染路径）；窗口会自动弹出，别动它
 *
 * 测什么：
 *   - convergeMs：进页面 → 力导收敛（alpha<0.0015 持续 8×400ms，d3 alpha 停摆坑的修正判据）
 *   - idle 3s：renderer.render 计数（#415 脏标记的签名指标，目标 0）+ 帧统计
 *   - zoom 6s：脚本滚轮缩放期帧统计（fps/p50/p95）
 * 输出：紧凑报告（可直接贴回）。
 */
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const web = get('--web', 'http://localhost:5173');
const daemon = get('--daemon', 'http://localhost:3100');
const needle = get('--vault');
if (!needle) {
  console.error('用法: node scripts/graph-perf-probe.mjs --vault <名称或路径子串> [--web ...] [--daemon ...]');
  process.exit(1);
}

// playwright 从 apps/web 的依赖解析（仓库根没有直接依赖）
const reqWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const reqTest = createRequire(reqWeb.resolve('@playwright/test'));
const { chromium } = reqTest(reqTest.resolve('playwright'));

const vs = await (await fetch(`${daemon}/api/knowledge/vaults`)).json();
const list = vs.vaults ?? vs;
const vault = list.find((v) => (v.name ?? '').includes(needle) || (v.path ?? '').includes(needle));
if (!vault) {
  console.error(`找不到 vault "${needle}"；现有：`, list.map((v) => `${v.name}|${v.path}`));
  process.exit(1);
}
console.log(`vault: ${vault.name} (${vault.id})`);

const browser = await chromium.launch({ headless: false, args: ['--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const t0 = Date.now();
await page.goto(`${web}/knowledge?vault=${vault.id}&panel=graph`);
await page.waitForFunction(() => !!window.__graphEngine?.sim, null, { timeout: 60000 });
const engineMs = Date.now() - t0;

// 收敛判据：alpha < 0.0015 持续 8×400ms（d3 停摆后 alpha 恒 ~0.001 不归零，不能用 >0）
await page.waitForFunction(
  () => {
    const w = window;
    w.__a = w.__a || { low: 0 };
    const a = w.__graphEngine.getSimState().alpha;
    if (a < 0.0015) w.__a.low++;
    else w.__a.low = 0;
    return w.__a.low >= 8;
  },
  null,
  { timeout: 360000, polling: 400 },
);
const convergeMs = Date.now() - t0;
await page.waitForTimeout(1500);

// 包一层 renderer.render 计数
await page.evaluate(() => {
  const r = window.__graphEngine.app.renderer;
  window.__renderCount = 0;
  const orig = r.render.bind(r);
  r.render = (...a) => {
    window.__renderCount++;
    return orig(...a);
  };
});

// 页内帧采样器：rAF 时间戳差值收集 ms 毫秒
const startSampler = (key, ms) =>
  page.evaluate(
    ({ key: k, ms: dur }) => {
      return new Promise((res) => {
        const t0 = performance.now();
        const dts = [];
        let last = t0;
        const tick = (t) => {
          dts.push(t - last);
          last = t;
          if (t - t0 < dur) requestAnimationFrame(tick);
          else {
            dts.sort((a, b) => a - b);
            const q = (p) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
            window[k] = {
              fps: +((1000 * dts.length) / (t - t0)).toFixed(1),
              p50: +q(0.5).toFixed(1),
              p95: +q(0.95).toFixed(1),
              frames: dts.length,
            };
            res(window[k]);
          }
        };
        requestAnimationFrame(tick);
      });
    },
    { key, ms },
  );

const idle = await startSampler('__idleStats', 3000);
const idleRenders = await page.evaluate(() => window.__renderCount);

// 缩放 6s：鼠标移到窗口中心（画布占满窗口），CDP 滚轮驱动，页内同时采样
await page.mouse.move(800, 500);
const zoomPromise = startSampler('__zoomStats', 6000);
const wheelLoop = (async () => {
  for (let i = 0; i < 100; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(60);
  }
})();
const zoom = await zoomPromise;
await wheelLoop;
const zoomRendersTotal = await page.evaluate(() => window.__renderCount);

await browser.close();

const report = {
  vault: vault.name,
  engineReadyMs: engineMs,
  convergeMs,
  idleRenders3s: idleRenders,
  idle,
  zoom,
  zoomRendersTotal,
};
console.log('=== graph-perf-probe ===');
console.log(`engineReady: ${(engineMs / 1000).toFixed(1)}s | converge: ${(convergeMs / 1000).toFixed(1)}s`);
console.log(`idle 3s: renders=${idleRenders} (目标 0) | fps=${idle.fps} p50=${idle.p50}ms`);
console.log(`zoom 6s: fps=${zoom.fps} p50=${zoom.p50}ms p95=${zoom.p95}ms (renders=${zoomRendersTotal})`);
console.log(`JSON: ${JSON.stringify(report)}`);
