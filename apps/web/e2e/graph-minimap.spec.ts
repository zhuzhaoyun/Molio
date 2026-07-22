import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P1
 *
 * Minimap 回归：右下角小地图挂载可见，且视口指示框用与节点一致的
 * 原始图坐标计算（不能混用归一化的 camera.x——同 zoomToNode 的坐标系坑）。
 * 默认看全图时视口框应几乎盖满 minimap；若混用归一化坐标，框会明显偏小错位。
 */

const DAEMON_API = 'http://localhost:3100/api';
const MM_W = 160;

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
const vaultName = `e2e-graph-minimap-${Date.now()}`;

test.beforeAll(async () => {
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-graph-minimap-')) {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon 可能没起 */ }

  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graph-minimap-'));
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

test.describe('Graph minimap', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, vaultId);
  });

  test('minimap is mounted and viewport box covers the full graph at default zoom', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await page.waitForSelector('.graph-sigma canvas', { timeout: 15_000 });
    await page.waitForTimeout(2000);

    // 挂载可见
    const minimap = page.locator('.graph-minimap');
    await expect(minimap).toBeVisible({ timeout: 5_000 });

    // 视口框（与节点同一坐标系换算）：默认看全图时应几乎盖满 minimap。
    // 若退回「混用归一化 camera.x」的错误算法，框会明显偏小（w 远小于 minimap 宽度）。
    const rectW = await page.evaluate((MM_W_inner) => {
      const s = (window as unknown as { __sigma?: any; __graph?: any }).__sigma;
      const g = (window as unknown as { __sigma?: any; __graph?: any }).__graph;
      if (!s || !g) return -1;
      const dims = s.getDimensions();
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      g.forEachNode((_k: string, a: { x: number; y: number }) => {
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
      });
      const gW = maxX - minX || 1;
      const gH = maxY - minY || 1;
      const pad = 0.08;
      const scale = Math.min((MM_W_inner * (1 - pad * 2)) / gW, (110 * (1 - pad * 2)) / gH);
      const corners = [[0, 0], [dims.width, 0], [0, dims.height], [dims.width, dims.height]]
        .map(([x, y]) => s.viewportToGraph({ x, y }));
      const cxs = corners.map((c) => c.x);
      return (Math.max(...cxs) - Math.min(...cxs)) * scale;
    }, MM_W);

    // 默认看全图：视口框宽度应 >= 80% minimap 宽度（错误算法只有 ~60%）
    expect(rectW).toBeGreaterThan(MM_W * 0.8);
  });
});
