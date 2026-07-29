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
    await page.waitForTimeout(2000); // 等模拟沉降

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

    // 按下瞬间：customBBox 应被冻结（非 null），记录固定参考点的图坐标 + 整图包围盒 span
    const down = await page.evaluate((vp) => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma;
      const g = w.__graph;
      if (!s || !g) return null;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        const x = a.x ?? 0, y = a.y ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      });
      return {
        bbox: s.getCustomBBox(),
        ref: s.viewportToGraph({ x: vp.x, y: vp.y }),
        span: Math.max(maxX - minX, maxY - minY),
      };
    }, { x: pos!.x, y: pos!.y });
    expect(down).not.toBeNull();
    expect(down!.bbox).not.toBeNull();
    expect(down!.span).toBeGreaterThan(0);

    // 拖拽中持续移动（模拟持续 wake、节点流动）
    await page.mouse.move(startX + 40, startY + 40, { steps: 10 });

    // 固定图坐标点的视口映射必须恒定（缩放/包围盒轴冻结 + 相机冻结）
    const during = await page.evaluate((ref) => {
      const w = window as unknown as { __sigma?: any; __graph?: any };
      const s = w.__sigma;
      const g = w.__graph;
      if (!s || !g) return null;
      const vp = s.graphToViewport(ref);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      g.forEachNode((_k: string, a: { x: number; y: number; hidden?: boolean }) => {
        if (a.hidden) return;
        const x = a.x ?? 0, y = a.y ?? 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      });
      return { x: vp.x, y: vp.y, bbox: s.getCustomBBox(), span: Math.max(maxX - minX, maxY - minY) };
    }, down!.ref);
    expect(during).not.toBeNull();
    // 映射应仍落在按下时的视口点附近（零漂移；容差 1px 抗浮点噪声）
    expect(during!.x).toBeCloseTo(pos!.x, 0);
    expect(during!.y).toBeCloseTo(pos!.y, 0);
    expect(during!.bbox).not.toBeNull();
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
      return s ? s.getCustomBBox() : 'no-sigma';
    });
    expect(rightAfterUp).not.toBeNull();

    // 沉降完成后冻结仍保留（不 refit）→ customBBox 仍非空、视口映射依旧稳定，
    // 证明相机在「拖拽中 + 松手沉降后」全程零漂移。
    await page.waitForTimeout(1200);
    const afterSettle = await page.evaluate((ref) => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      if (!s) return null;
      const vp = s.graphToViewport(ref);
      return { x: vp.x, y: vp.y, bbox: s.getCustomBBox() };
    }, down!.ref);
    expect(afterSettle).not.toBeNull();
    expect(afterSettle!.bbox).not.toBeNull();
    expect(afterSettle!.x).toBeCloseTo(pos!.x, 0);
    expect(afterSettle!.y).toBeCloseTo(pos!.y, 0);
  });

  // 注：minimap 世界框冻结（getCustomBBox() ?? getBBox()，与主相机归一化同源）的修复，无法在
  // 小图 E2E 中确定性复现——弱向心力（centerStrengthForDegree）在小图里把孤立/低度节点稳在
  // 圆环附近，实时包围盒不会发散；该 bug 只在大图+长拖拽下弱锚定节点漂出冻结框时出现
  // （用户截图的角落飞点）。故此处不写 flaky 的像素/发散断言，minimap 修复的正确性由
  // 「基准与 normalizationFunction 同源」+ typecheck + 浏览器实测保证；vault 内的孤立节点
  // (delta.md) 仍让 syncIsolatedToSim / tile 路径在上面的拖拽测试中被执行到。
});
