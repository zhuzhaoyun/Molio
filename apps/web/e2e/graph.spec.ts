import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @area graph
 * @priority P1
 *
 * E2E tests for the Graph (knowledge graph) page.
 *
 * Graph rendering depends on Sigma.js WebGL — these tests verify page structure
 * and state display rather than pixel-perfect rendering.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Graph', () => {
  test('page loads and shows graph page shell', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });
  });

  test('shows empty state or canvas when no vault selected', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Without a vault, should show either empty state or a canvas with no data
    const emptyState = page.locator('.graph-empty');
    const canvas = page.locator('.graph-canvas');

    // At least one of these should be visible
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasCanvas = await canvas.isVisible({ timeout: 1_000 }).catch(() => false);

    expect(hasEmpty || hasCanvas).toBe(true);
  });

  test('canvas container or empty state exists in graph page', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // When no vault is selected, .graph-empty is shown instead of .graph-canvas.
    // When a vault is selected, .graph-canvas exists. At least one must be present.
    const canvas = page.locator('.graph-canvas');
    const emptyState = page.locator('.graph-empty');
    const hasCanvas = await canvas.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasEmpty = await emptyState.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasCanvas || hasEmpty).toBe(true);
  });
});

test.describe('Graph drag auto-quality (移动时自动降质)', () => {
  let testVaultPath: string;
  let vaultId: string;
  const vaultName = `e2e-graph-drag-quality-${Date.now()}`;

  test.beforeAll(async () => {
    // 清理上次崩溃遗留的同名 vault
    try {
      const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
      const { vaults } = await list.json();
      for (const v of vaults as { id: string; name: string }[]) {
        if (v.name.startsWith('e2e-graph-drag-quality-')) {
          await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    } catch { /* daemon 可能没起 */ }

    // 3 节点 < ML 触发阈值(50)，不会触发 multi-level 布局，测试稳定
    testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graph-drag-quality-'));
    writeFileSync(join(testVaultPath, 'alpha.md'), '# Alpha\n\n[[beta]] [[gamma]]\n');
    writeFileSync(join(testVaultPath, 'beta.md'), '# Beta\n\n[[gamma]]\n');
    writeFileSync(join(testVaultPath, 'gamma.md'), '# Gamma\n\n(no links)\n');
    // 孤立节点（无任何 wikilink → degree 0）：拖拽「全流动」会解锁它、排斥力将其甩飞，
    // 用于回归覆盖 syncIsolatedToSim / tile 平铺、以及 minimap 冻结世界框逻辑。
    writeFileSync(join(testVaultPath, 'delta.md'), '# Delta\n\n(no links, isolated)\n');

    const res = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName, path: testVaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    if (vaultId) {
      await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (testVaultPath) {
      rmSync(testVaultPath, { recursive: true, force: true });
    }
  });

  test('dragging a node hides labels and restores them on release', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(2000); // 等模拟沉降

    // 基准：拖拽前标签开启
    const before = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(before).toBe(true);

    // 取任一节点的 viewport 坐标
    const pos = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return null;
      let found: { x: number; y: number } | null = null;
      g.forEachNode((_k: string, a: { x: number; y: number }) => {
        if (found) return;
        found = s.graphToViewport({ x: a.x, y: a.y });
      });
      return found;
    });
    expect(pos).not.toBeNull();

    const canvas = page.locator('.graph-sigma canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + pos!.x;
    const startY = box!.y + pos!.y;

    // 按住 → 移动 30px（超过 DRAG_THRESHOLD=4）→ 标签应关闭
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 30, startY + 30, { steps: 6 });

    const during = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(during).toBe(false);

    // 松手 → 标签恢复
    await page.mouse.up();
    const after = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      return s ? s.getSetting('renderLabels') : null;
    });
    expect(after).toBe(true);
  });

  // 回归：拖拽节点时相机视角必须稳定（"视角频繁切换" bug）。
  // 根因：拖拽 wake 让全图流动，包围盒质心每 tick 漂移 → sigma process() 用新质心
  // 重算 normalizationFunction → 固定相机下整图逐帧跳动。修复用 setCustomBBox 冻结
  // 归一化包围盒。相机 state(x/y/ratio) 本身始终不变，故不能只断言相机 state，要断言
  // 「固定图坐标点的视口映射」拖拽全程恒定 + customBBox 拖拽中非空/松手清空。
  test('dragging a node keeps the viewport mapping stable (no camera jitter)', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    // 等入场过渡（模糊→清晰+淡入 / bloom）完成，再交互；并断言揭示类已移除（入场真的结束、非卡住）
    await page.waitForFunction(
      () => (window as unknown as { __graphIntroDone?: boolean }).__graphIntroDone === true,
      null,
      { timeout: 10_000 },
    );
    // 吸收 React StrictMode 二次挂载 / SWR 后台 refetch 触发的二次重建+软入场，确保图谱稳定后再交互
    // （否则测试抓到的节点引用可能与重建后的可见图错位，造成"二次拖拽不跟手"的假失败）。
    await page.waitForTimeout(1500);
    await expect(page.locator('.graph-sigma')).not.toHaveClass(/graph-intro/);

    const pos = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return null;
      let found: { x: number; y: number } | null = null;
      g.forEachNode((_k: string, a: { x: number; y: number }) => {
        if (found) return;
        found = s.graphToViewport({ x: a.x, y: a.y });
      });
      return found;
    });
    expect(pos).not.toBeNull();

    const canvas = page.locator('.graph-sigma canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + pos!.x;
    const startY = box!.y + pos!.y;

    await page.mouse.move(startX, startY);
    await page.mouse.down();

    // 按下瞬间：customBBox 应被冻结（非 null），记录固定参考点的图坐标 + 整图包围盒 span + 整簇质心。
    // 质心 = 可见节点图坐标均值 → 视口坐标（§12.2 质心锁的守护：拖拽期 forceCenter 把质心钉在按下瞬间位置，
    // 松手回弹后整簇不漂移；若质心锁失效/被移除，磁铁净动量会把质心推走 10px+，此断言必挂）。
    const down = await page.evaluate((vp) => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma;
      const g = w.__graph;
      if (!s || !g) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let sx = 0, sy = 0, n = 0;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        const x = a.x ?? 0, y = a.y ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        sx += x; sy += y; n++;
      });
      const cst = (s.getCamera() as any).getState();
      const centroid = n > 0 ? s.graphToViewport({ x: sx / n, y: sy / n }) : null;
      return {
        bbox: s.getCustomBBox(),
        ref: s.viewportToGraph({ x: vp.x, y: vp.y }),
        span: Math.max(maxX - minX, maxY - minY),
        cam: { x: cst.x, y: cst.y, ratio: cst.ratio },
        centroid,
      };
    }, { x: pos!.x, y: pos!.y });
    expect(down).not.toBeNull();
    expect(down!.bbox).not.toBeNull();
    expect(down!.span).toBeGreaterThan(0);
    expect(down!.centroid).not.toBeNull();

    // 拖拽中持续移动（模拟持续 wake、节点流动）
    await page.mouse.move(startX + 40, startY + 40, { steps: 10 });
    // 按住停顿 700ms：让磁铁注入的速度被 forceCenter 收敛（质心残差由 mean(vx) 决定，小图需多
    // tick 才能把均值拉回 C0；一到位立刻测量会拿到瞬态 8px+ 误报）。按住停顿=真实拖拽场景。
    // 流体在过阈值处才安装（§12.5 单击修复），sim 启动比旧版晚，故停顿需略长于 400ms。
    await page.waitForTimeout(700);

    // 固定图坐标点的视口映射必须恒定（缩放/包围盒轴冻结 + 相机冻结）
    const during = await page.evaluate((ref) => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma;
      const g = w.__graph;
      if (!s || !g) return null;
      const vp = s.graphToViewport(ref);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let sx = 0, sy = 0, n = 0;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        const x = a.x ?? 0, y = a.y ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        sx += x; sy += y; n++;
      });
      const cst = (s.getCamera() as any).getState();
      const centroid = n > 0 ? s.graphToViewport({ x: sx / n, y: sy / n }) : null;
      return { x: vp.x, y: vp.y, bbox: s.getCustomBBox(), span: Math.max(maxX - minX, maxY - minY), cam: { x: cst.x, y: cst.y, ratio: cst.ratio }, centroid };
    }, down!.ref);
    expect(during).not.toBeNull();
    // 映射应仍落在按下时的视口点附近（零漂移；容差 1px 抗浮点噪声）
    expect(during!.x).toBeCloseTo(pos!.x, 0);
    expect(during!.y).toBeCloseTo(pos!.y, 0);
    expect(during!.bbox).not.toBeNull();
    // 质心锁守护（§12.2 第 1 层）：拖拽中 forceCenter 把整簇质心钉在按下瞬间位置，
    // 磁铁净动量不能移动整簇。容差 4px = §7 的 forceCenter+钉住节点残差(~1.4px)留余量；
    // 无质心锁时磁铁把质心推走 10px+，必挂。注意断言放「拖拽中」而非「回弹结束后」——
    // 回弹结束后质心锁已被 onTick 自动解除、被拖节点停在半路，质心移动是正常布局调整。
    expect(during!.centroid).not.toBeNull();
    expect(Math.abs(during!.centroid!.x - down!.centroid!.x)).toBeLessThan(4);
    expect(Math.abs(during!.centroid!.y - down!.centroid!.y)).toBeLessThan(4);
    // 路线 B 烟检：拖拽期整图包围盒不得爆炸式撑大 / 出现 NaN（磁铁写错→速度 runaway 的标志）。
    // 阈值放宽到 20×：4 节点小图上"正常拖拽"（被拖节点本身位移 + 强磁铁推开孤立节点）span 也会数倍
    // 变化，紧阈值会误报；真正的飞散/失控是数百倍以上。流体的"浓淡/手感"无法在小图像素级断言，
    // 靠浏览器目测迭代；相机稳定由上面的映射冻结 + customBBox 冻结精确保证。
    expect(Number.isFinite(during!.span)).toBe(true);
    expect(during!.span).toBeLessThan(down!.span * 20);

    // 松手 → 视角保持冻结（对齐 Obsidian：拖拽/松手都不动相机，绝不 refit）
    await page.mouse.up();
    const rightAfterUp = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      if (!s) return null;
      const cst = (s.getCamera() as any).getState();
      return { bbox: s.getCustomBBox(), cam: { x: cst.x, y: cst.y, ratio: cst.ratio } };
    });
    expect(rightAfterUp).not.toBeNull();
    expect(rightAfterUp!.bbox).not.toBeNull();

    // 回弹中段（节点正在弹回、位置剧烈变化）：相机 state 仍必须与按下时完全一致 →
    // 证明「节点动」不会带动相机（customBBox 冻结 → 归一化不变 → 相机不漂）。
    await page.waitForTimeout(600);
    const midRebound = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      if (!s) return null;
      const cst = (s.getCamera() as any).getState();
      return { cam: { x: cst.x, y: cst.y, ratio: cst.ratio } };
    });
    expect(midRebound).not.toBeNull();

    // 回弹结束后冻结仍保留（不 refit）→ customBBox 仍非空、视口映射依旧稳定。
    await page.waitForTimeout(1900); // 累计 ~2.5s，覆盖慢放回弹全程
    const afterSettle = await page.evaluate((ref) => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      if (!s) return null;
      const vp = s.graphToViewport(ref);
      const cst = (s.getCamera() as any).getState();
      return { x: vp.x, y: vp.y, bbox: s.getCustomBBox(), cam: { x: cst.x, y: cst.y, ratio: cst.ratio } };
    }, down!.ref);
    expect(afterSettle).not.toBeNull();
    expect(afterSettle!.bbox).not.toBeNull();
    expect(afterSettle!.x).toBeCloseTo(pos!.x, 0);
    expect(afterSettle!.y).toBeCloseTo(pos!.y, 0);

    // 相机视角全程零漂移：按下 / 拖拽中 / 松手瞬间 / 回弹中段 / 回弹结束 五点相机 state 完全一致。
    // 这是相机稳定性的硬核断言——回弹期节点位置在变，若相机/归一化没冻住，这里必挂。
    for (const sample of [during!, rightAfterUp!, midRebound!, afterSettle!]) {
      expect(sample.cam.x).toBeCloseTo(down!.cam.x, 4);
      expect(sample.cam.y).toBeCloseTo(down!.cam.y, 4);
      expect(sample.cam.ratio).toBeCloseTo(down!.cam.ratio, 4);
    }
  });

  // 注：minimap 世界框冻结（getCustomBBox() ?? getBBox()，与主相机归一化同源）的修复，无法在
  // 小图 E2E 中确定性复现——弱向心力（centerStrengthForDegree）在小图里把孤立/低度节点稳在
  // 圆环附近，实时包围盒不会发散；该 bug 只在大图+长拖拽下弱锚定节点漂出冻结框时出现
  // （用户截图的角落飞点）。故此处不写 flaky 的像素/发散断言，minimap 修复的正确性由
  // 「基准与 normalizationFunction 同源」+ typecheck + 浏览器实测保证；vault 内的孤立节点
  // (delta.md) 仍让 syncIsolatedToSim / tile 路径在上面的拖拽测试中被执行到。

  // 回归：第一次松手后再拖，被拖节点仍必须跟手（守护 halt 的非破坏性）。
  // 旧 bug：freezeAllNow 误用破坏性 stop() → 清空节点句柄 + terminate worker + modeRef=null →
  // 第二次拖拽 getNode=undefined → handleMouseMove 写坐标被 if(d3Node) 跳过 → 节点拖不动；
  // beginDrag/wake 也因 sim/mode 为 null 失效。单次拖拽的测试抓不到，故这里连做两次拖拽。
  test('node still follows cursor on a second drag after release (halt non-destructive)', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(2000);

    const canvas = page.locator('.graph-sigma canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    // 首个可见节点 key + 视口坐标
    const first = await page.evaluate(() => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma; const g = w.__graph;
      if (!s || !g) return null;
      let key: string | null = null;
      let vp: { x: number; y: number } | null = null;
      g.forEachNode((k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (key || a.hidden) return;
        key = k; vp = s.graphToViewport({ x: a.x ?? 0, y: a.y ?? 0 });
      });
      return key && vp ? { key, vp } : null;
    });
    expect(first).not.toBeNull();

    const readVp = (key: string) => page.evaluate((k) => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      const g = (window as unknown as { __graph?: any }).__graph;
      if (!s || !g || !g.hasNode(k)) return null;
      return s.graphToViewport({ x: g.getNodeAttribute(k, 'x'), y: g.getNodeAttribute(k, 'y') });
    }, key);

    const p0 = first!.vp!;
    // 第一次拖拽 +40（首次拖拽在 bug/fix 下都能动）
    await page.mouse.move(box!.x + p0.x, box!.y + p0.y);
    await page.mouse.down();
    await page.mouse.move(box!.x + p0.x + 40, box!.y + p0.y + 40, { steps: 8 });
    await page.mouse.up();
    // 物理回弹版：被拖节点松手后放开、弹回「落点↔原位」之间并停住；回弹已慢放(~2–2.5s)，
    // 故等 2500ms 沉降再读静止位置 p1，第二次拖拽从 p1 抓起。p1 介于 p0 与 p0+40 之间。
    await page.waitForTimeout(2500);
    const p1 = (await readVp(first!.key!))!;

    // 第二次拖拽：从 p1 再 +30，拖拽中读位置，必须真跟到 ≈ p1+30（bug 下会停在 p1 不动）
    await page.mouse.move(box!.x + p1.x, box!.y + p1.y);
    await page.mouse.down();
    await page.mouse.move(box!.x + p1.x + 30, box!.y + p1.y + 30, { steps: 8 });
    const p2 = (await readVp(first!.key!))!;
    await page.mouse.up();

    expect(Math.abs(p2.x - (p1.x + 30))).toBeLessThan(3);
    expect(Math.abs(p2.y - (p1.y + 30))).toBeLessThan(3);
  });

  // 回归：单击选中节点（按下→松手，未超过 DRAG_THRESHOLD=4px）时图谱不得有任何运动。
  // 旧 bug：mousedown 命中节点就立刻 beginDrag + wake(0.3)，即使鼠标没动也激活磁铁/拴绳/质心锁，
  // 整图"呼吸"一下直到 mouseup 的 freezeAllNow 才停 = 每次点击都抖动。修复：把流体安装延后到
  // handleMouseMove 超过拖拽阈值处，单击路径全程零力（§12.5 点击抖动修复）。
  test('single-click selects a node without moving the graph (no click jitter)', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForFunction(
      () => (window as unknown as { __graphIntroDone?: boolean }).__graphIntroDone === true,
      null,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(1500);

    // 记录点击前整簇质心（可见节点均值 → 视口）+ 相机 state
    const snapshot = await page.evaluate(() => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma, g = w.__graph;
      if (!s || !g) return null;
      let sx = 0, sy = 0, n = 0;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        sx += a.x ?? 0; sy += a.y ?? 0; n++;
      });
      const cst = (s.getCamera() as any).getState();
      return n > 0 ? { centroid: s.graphToViewport({ x: sx / n, y: sy / n }), cam: { x: cst.x, y: cst.y, ratio: cst.ratio } } : null;
    });
    expect(snapshot).not.toBeNull();

    // 取首个可见节点位置，模拟单击（按下→原地松手，无位移）
    const clickAt = await page.evaluate(() => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma, g = w.__graph;
      if (!s || !g) return null;
      let vp: { x: number; y: number } | null = null;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (vp) return;
        vp = s.graphToViewport({ x: a.x ?? 0, y: a.y ?? 0 });
      });
      return vp;
    });
    expect(clickAt).not.toBeNull();

    const canvas = page.locator('.graph-sigma canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + clickAt!.x, box!.y + clickAt!.y);
    await page.mouse.down();
    await page.mouse.up();

    // 单击后等一小段（若有 bug 的 wake 抖动，此刻应该已产生位移），再对比质心 + 相机
    await page.waitForTimeout(400);
    const afterClick = await page.evaluate(() => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma, g = w.__graph;
      if (!s || !g) return null;
      let sx = 0, sy = 0, n = 0;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        sx += a.x ?? 0; sy += a.y ?? 0; n++;
      });
      const cst = (s.getCamera() as any).getState();
      return n > 0 ? { centroid: s.graphToViewport({ x: sx / n, y: sy / n }), cam: { x: cst.x, y: cst.y, ratio: cst.ratio } } : null;
    });
    expect(afterClick).not.toBeNull();
    // 单击后整簇质心不动（容差 1px 抗浮点噪声；若有 mousedown 即 wake 的抖动会移动数 px）
    expect(Math.abs(afterClick!.centroid!.x - snapshot!.centroid!.x)).toBeLessThan(1);
    expect(Math.abs(afterClick!.centroid!.y - snapshot!.centroid!.y)).toBeLessThan(1);
    // 相机不动
    expect(afterClick!.cam.x).toBeCloseTo(snapshot!.cam.x, 4);
    expect(afterClick!.cam.y).toBeCloseTo(snapshot!.cam.y, 4);
    expect(afterClick!.cam.ratio).toBeCloseTo(snapshot!.cam.ratio, 4);
  });
});
