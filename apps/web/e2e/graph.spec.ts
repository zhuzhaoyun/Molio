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
});
