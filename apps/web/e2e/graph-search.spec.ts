import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P1
 *
 * 回归测试：节点搜索点击结果后，相机必须飞到节点处（节点在视口内），
 * 而不是飞到归一化空间外的空处（Sigma 渲染空白 + 交互失效）。
 *
 * 根因（2026-07-22 定位）：zoomToNode 把节点原始图坐标直接喂给
 * `camera.animate`，但 Sigma 相机工作在归一化(framed)空间，导致视图
 * 被甩到 extent×ratio 远处，整张图渲染空白。
 */

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

let testVaultPath: string;
let vaultId: string;
const vaultName = `e2e-graph-search-${Date.now()}`;

test.beforeAll(async () => {
  // 清理上次崩溃遗留的同名 vault
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-graph-search-')) {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon 可能没起 */ }

  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graph-search-'));
  writeFileSync(join(testVaultPath, 'alpha.md'), '# Alpha\n\n[[beta]] [[gamma]]\n');
  writeFileSync(join(testVaultPath, 'beta.md'), '# Beta\n\n[[gamma]]\n');
  writeFileSync(join(testVaultPath, 'gamma.md'), '# Gamma\n\n(no links)\n');

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

test.describe('Graph node search', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
  });

  test('clicking a search result keeps nodes in the viewport', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    // 等画布 + 模拟沉降
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(2000);

    // Ctrl/Cmd+F 打开搜索（监听在 passive effect，稍等其挂载）
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+f');
    const input = page.locator('[data-testid="graph-search-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });

    await input.fill('beta');
    const firstResult = page.locator('[data-testid="graph-search-result"]').first();
    await expect(firstResult).toBeVisible({ timeout: 5_000 });
    await firstResult.click();

    // 等 camera.animate (600ms) 完成
    await page.waitForTimeout(1200);

    // 回归断言：搜索后至少一个节点仍在视口内（坏时代码相机会飞到归一化空间外，inView=0）
    const inView = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return -1;
      const w = s.getContainer().clientWidth;
      const h = s.getContainer().clientHeight;
      let n = 0;
      g.forEachNode((_k: string, a: { x: number; y: number }) => {
        const vp = s.graphToViewport({ x: a.x, y: a.y });
        if (vp.x >= 0 && vp.x <= w && vp.y >= 0 && vp.y <= h) n++;
      });
      return n;
    });

    expect(inView).toBeGreaterThan(0);
  });

  test('does not move camera when searched node is already in viewport', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(3000); // 等模拟沉降

    // 先把相机对准 beta（归一化坐标），确保它落在「舒适可视区」内
    const before = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return null;
      const keys: string[] = [];
      g.forEachNode((k: string) => keys.push(k));
      const betaKey = keys.find((k) => k.includes('beta'));
      if (!betaKey) return null;
      const a = g.getNodeAttributes(betaKey);
      const framed = s.viewportToFramedGraph(s.graphToViewport({ x: a.x, y: a.y }));
      s.getCamera().setState({ x: framed.x, y: framed.y, ratio: 2 });
      const c = s.getCamera().getState();
      return { x: c.x, y: c.y, ratio: c.ratio };
    });
    expect(before).not.toBeNull();

    // UI 搜索 beta 并点击结果
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+f');
    const input = page.locator('[data-testid="graph-search-input"]');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('beta');
    const firstResult = page.locator('[data-testid="graph-search-result"]').first();
    await expect(firstResult).toBeVisible({ timeout: 5_000 });
    await firstResult.click();
    await page.waitForTimeout(1200);

    const after = await page.evaluate(() => {
      const s = (window as unknown as { __sigma?: any }).__sigma;
      const c = s.getCamera().getState();
      return { x: c.x, y: c.y, ratio: c.ratio };
    });

    // 节点已在视口内 → 相机不应移动（只高亮不飞）
    expect(after.ratio).toBeCloseTo(before!.ratio, 3);
    expect(after.x).toBeCloseTo(before!.x, 3);
    expect(after.y).toBeCloseTo(before!.y, 3);
  });
});
