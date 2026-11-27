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
/** --expand [clusterId]：H2 展开测量（缺省取 communities 最大簇；传 true 走自动） */
const expandArg = args.indexOf('--expand');
const expand = expandArg >= 0 ? (args[expandArg + 1] && !args[expandArg + 1].startsWith('--') ? args[expandArg + 1] : true) : null;
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
// 静息等待：收敛判据放行时 alpha 可能仍 ~0.0012（d3 停摆坑），动画尾巴会落进采样窗
// 造成「空闲 renders≠0」误读——多等让余帧彻底息止（稳态 0 已被专项验证）
await page.waitForTimeout(4500);

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

// ── H3 布局种子指标：payload positions 覆盖率 + 首快照偏差 + 2s 后漂移 ──
// 大库默认进 trunk——种子量的是全量视图，先切过去（小库无开关，本来就在全量）
await page.click('[data-testid="graph-view-mode-toggle"]').catch(() => {});
await page
  .waitForFunction(() => window.__graphEngine?.getTrunkMode?.() === false, null, { timeout: 30000 })
  .catch(() => {});
// 注意此处快照已是收敛后（上面等过 converge），firstFrameDisp 语义 =
// 「种子坐标 vs 最终布局」的偏差（衡量种子质量）；出生定形的「首帧动量」
// 在 E2E（graph-seed.spec）用数据刚到时的快照量，探针这里量稳态贴合度。
// 全量 sim 的 alpha 真死后再采样（切视图后的精修在飞，中途读数会误读为漂移）
await page.waitForFunction(
  () => {
    const w = window;
    w.__b = w.__b || { low: 0 };
    const a = w.__graphEngine?.getSimState?.().alpha ?? 0;
    if (a < 0.0015) w.__b.low++;
    else w.__b.low = 0;
    return w.__b.low >= 8;
  },
  null,
  { timeout: 180000, polling: 400 },
).catch(() => {});
const graphRes = await page.request.get(`${daemon}/api/graph/${vault.id}`);
const graphJson = await graphRes.json();
let seedCoverage = 0;
let seedDeviation = null;
if (Array.isArray(graphJson.positions) && graphJson.positions.length > 0) {
  const seedJson = JSON.stringify(graphJson.positions);
  const dev = await page.evaluate((json) => {
    const seed = new Map(JSON.parse(json).map(([k, x, y]) => [k, { x, y }]));
    const snap = window.__graphEngine?.getSnapshot();
    if (!snap) return null;
    let sum = 0;
    let n = 0;
    for (const node of snap.nodes) {
      const p = seed.get(node.key);
      if (!p) continue;
      sum += Math.hypot(node.x - p.x, node.y - p.y);
      n++;
    }
    return n === 0 ? null : { mean: sum / n, n };
  }, seedJson);
  seedCoverage = +(dev && graphJson.nodes.length ? dev.n / graphJson.nodes.length : 0).toFixed(3);
  seedDeviation = dev ? +dev.mean.toFixed(1) : null;
}
await page.waitForTimeout(2000);
const seedDrift = await page.evaluate((json) => {
  const seed = new Map(JSON.parse(json).map(([k, x, y]) => [k, { x, y }]));
  const snap = window.__graphEngine?.getSnapshot();
  if (!snap) return null;
  let sum = 0;
  let n = 0;
  for (const node of snap.nodes) {
    const p = seed.get(node.key);
    if (!p) continue;
    sum += Math.hypot(node.x - p.x, node.y - p.y);
    n++;
  }
  return n === 0 ? null : +(sum / n).toFixed(1);
}, JSON.stringify(graphJson.positions ?? []));

const report = {
  vault: vault.name,
  engineReadyMs: engineMs,
  convergeMs,
  idleRenders3s: idleRenders,
  idle,
  zoom,
  zoomRendersTotal,
  seed: { coverage: seedCoverage, settledDisp: seedDeviation, dispAfter2s: seedDrift },
};
console.log('=== graph-perf-probe ===');
console.log(`engineReady: ${(engineMs / 1000).toFixed(1)}s | converge: ${(convergeMs / 1000).toFixed(1)}s`);
console.log(`idle 3s: renders=${idleRenders} (目标 0) | fps=${idle.fps} p50=${idle.p50}ms`);
console.log(`zoom 6s: fps=${zoom.fps} p50=${zoom.p50}ms p95=${zoom.p95}ms (renders=${zoomRendersTotal})`);
if (seedCoverage > 0) {
  console.log(`seed: coverage=${seedCoverage} settledDisp=${seedDeviation}px dispAfter2s=${seedDrift}px (贴合度; 出生定形线看 E2E)`);
} else {
  console.log('seed: 无（预跑未完成或旧 daemon）');
}

// ── 社区层级口径（换核：Louvain + 递归分级）── 对 /api/graph 直接统计（幂等可重跑）
{
  const cg = await (await fetch(`${daemon}/api/graph/${vault.id}`)).json();
  const cls = cg?.communities?.clusters ?? [];
  const total = (cg?.nodes ?? []).length;
  if (cls.length > 0 && total > 0) {
    const withChildren = cls.filter((c) => Array.isArray(c.children));
    const leaves = [];
    for (const c of cls) {
      if (c.children?.length) for (const ch of c.children) leaves.push(ch.size);
      else leaves.push(c.size);
    }
    const maxShare = ((Math.max(...cls.map((c) => c.size)) / total) * 100).toFixed(1);
    console.log(
      `communities: L1=${cls.length} maxShare=${maxShare}% withChildren=${withChildren.length} leafMax=${Math.max(...leaves)} quality=${cg.communities.quality} crumb=${cg.communities.crumbCount}`,
    );
  } else {
    console.log('communities: 无（trunk 未启用或旧 daemon）');
  }
}

// ── H2 展开测量（--expand [clusterId]，缺省取 communities 最大簇）──
if (expand) {
  // trunk 态就位（大库默认 trunk；等引擎推完数据）
  await page.reload();
  await page.waitForFunction(() => window.__graphEngine?.getTrunkMode() === true, null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__graphEngine?.getSnapshot()?.nodes.length ?? 0) > 0, null, { timeout: 60000 });

  // 选簇：--expand 给 id；否则查 daemon communities 拿最大簇
  let clusterId = typeof expand === 'string' ? expand : null;
  let clusterSize = null;
  const g = await (await fetch(`${daemon}/api/graph/${vault.id}`)).json();
  const clusters = g?.communities?.clusters ?? [];
  if (!clusterId && clusters.length > 0) {
    const biggest = clusters.reduce((a, b) => (b.size > a.size ? b : a));
    clusterId = biggest.id;
    clusterSize = biggest.size;
  }
  if (!clusterId) {
    console.error('--expand: 找不到簇（communities 为空？）');
  } else {
    clusterSize = clusterSize ?? clusters.find((c) => c.id === clusterId)?.size ?? null;
    console.log(`expand: cluster=${clusterId} size=${clusterSize}`);

    const blobScreen = await page.evaluate((cid) => {
      const eng = window.__graphEngine;
      const snap = eng?.getSnapshot();
      const blob = snap?.nodes.find((n) => n.key === cid);
      if (!blob || !eng) return null;
      const rect = eng.canvas.getBoundingClientRect();
      const t = eng.getViewport();
      return { sx: rect.left + (blob.x + rect.width / 2) * t.k + t.tx, sy: rect.top + (blob.y + rect.height / 2) * t.k + t.ty };
    }, clusterId);
    if (!blobScreen) {
      console.error('--expand: 画布上找不到该簇 blob');
    } else {
      await page.evaluate(() => {
        const r = window.__graphEngine.app.renderer;
        window.__renderCount2 = 0;
        const orig = r.render.bind(r);
        r.render = (...a) => {
          window.__renderCount2++;
          return orig(...a);
        };
      });
      const tClick = Date.now();
      // 空闲计数基线：点击前清零——展开动画的 render 不许混进「展开后空闲」读数
      //（首版读累计值把过渡 tween 的 62 帧误报成空闲渲染，稳态实测为 0）
      await page.evaluate(() => { window.__renderCount2 = 0; });
      await page.mouse.click(blobScreen.sx, blobScreen.sy);
      // 首批可见（250ms 点击 defer + 首批落位）
      await page.waitForFunction(
        (cid) => window.__graphEngine?.getTrunkExpandedClusters().includes(cid),
        clusterId,
        { timeout: 10000 },
      );
      const firstBatchMs = Date.now() - tClick;
      // 流式补齐：快照长度稳定（2×600ms 采样一致）
      const streamDone = await page.waitForFunction(
        () => {
          const w = window;
          const n = w.__graphEngine?.getSnapshot()?.nodes.length ?? -1;
          if (w.__snapN === n) w.__stable++;
          else w.__stable = 0;
          w.__snapN = n;
          return w.__stable >= 2;
        },
        null,
        { timeout: 20000, polling: 600 },
      ).then(() => true, () => false);
      const streamMs = Date.now() - tClick;
      const nodes = await page.evaluate(() => window.__graphEngine?.getSnapshot()?.nodes.length ?? -1);
      const transitionRenders = await page.evaluate(() => window.__renderCount2);
      await page.waitForTimeout(4500); // 过渡动画+批次流息止（余帧不落进空闲采样窗）
      await page.evaluate(() => { window.__renderCount2 = 0; }); // 空闲窗口重新计
      const idle2 = await startSampler('__idle2Stats', 3000);
      const idle2Renders = await page.evaluate(() => window.__renderCount2);
      // 展开态缩放 6s
      await page.mouse.move(800, 500);
      const zoom2Promise = startSampler('__zoom2Stats', 6000);
      const wheel2 = (async () => {
        for (let i = 0; i < 100; i++) {
          await page.mouse.wheel(0, -120);
          await page.waitForTimeout(60);
        }
      })();
      const zoom2 = await zoom2Promise;
      await wheel2;
      // hover 质心附近的成员 → 标签数（统一 LOD 规则 ≤60）
      const hoverLabels = await page.evaluate((cid) => {
        const eng = window.__graphEngine;
        const chip = eng?.getTrunkCollapseChipPos(cid);
        return chip ? { sx: chip.sx, sy: chip.sy } : null;
      }, clusterId).then(async (chip) => {
        if (!chip) return -1;
        const rect = await page.evaluate(() => {
          const r = window.__graphEngine.canvas.getBoundingClientRect();
          return { left: r.left, top: r.top };
        });
        // 从 chip 附近偏移一点，落在成员密集区
        await page.mouse.move(rect.left + chip.sx + 40, rect.top + chip.sy + 30);
        await page.waitForTimeout(500); // hover tween + linger
        return page.evaluate(() => window.__graphEngine?.getVisibleLabelCount() ?? -1);
      });

      console.log(`expand: firstBatch=${(firstBatchMs / 1000).toFixed(2)}s | streamDone=${streamDone} streamTotal=${(streamMs / 1000).toFixed(2)}s | nodes=${nodes} | transitionRenders=${transitionRenders}`);
      console.log(`expanded idle 3s: renders=${idle2Renders} (目标 0) | fps=${idle2.fps} p50=${idle2.p50}ms`);
      console.log(`expanded zoom 6s: fps=${zoom2.fps} p50=${zoom2.p50}ms p95=${zoom2.p95}ms`);
      console.log(`hover labels: ${hoverLabels} (红线 ≤60)`);
      report.expand = { clusterId, clusterSize, firstBatchMs, streamDone, streamMs, nodes, transitionRenders, idle2Renders, idle2, zoom2, hoverLabels };
    }
  }
}
console.log(`JSON: ${JSON.stringify(report)}`);
await browser.close();
