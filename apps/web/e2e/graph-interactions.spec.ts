import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @area graph
 * @priority P1
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
const vaultName = `e2e-graphint-${Date.now()}`;

test.beforeAll(async () => {
  // Purge any stale vaults left over from crashed runs
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-graphint-')) {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon might not be running yet */ }

  // fixture：alpha↔beta 互链 + [[ghost]] 死链 + gamma 孤立
  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-graphint-'));
  writeFileSync(join(testVaultPath, 'alpha.md'), '# Alpha\n\n[[beta]] 和 [[ghost]]\n');
  writeFileSync(join(testVaultPath, 'beta.md'), '# Beta\n\n[[alpha]] 与 [[gamma]]\n');
  writeFileSync(join(testVaultPath, 'gamma.md'), '# Gamma\n\n孤立文件\n');

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem('molio.activeVaultId', id);
  }, vaultId);
});

/** 等力模拟收敛（连续两次采样节点位置不变），再等相机适配动画结束 */
async function waitForSettle(page: Page) {
  await page.waitForSelector('.graph-svg-host svg g circle', { timeout: 15_000 });
  let prev = '';
  for (let i = 0; i < 60; i++) {
    const cur = await page.evaluate(() => {
      const g = document.querySelector('.graph-svg-host svg .graph-root g g');
      return g?.getAttribute('transform') ?? '';
    });
    if (cur && cur === prev) break;
    prev = cur;
    await page.waitForTimeout(400);
  }
  // 收敛后的自动 fitToView 相机动画 400ms
  await page.waitForTimeout(700);
}

/** 节点 g 的主圆（expansionRing/activeRing/circle 中的第 3 个） */
function nodeCircle(page: Page, label: string) {
  return page
    .locator('.graph-svg-host svg g')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator('circle')
    .nth(2);
}

test('renders SVG nodes for every vault file plus dead links', async ({ page }) => {
  await page.goto('/graph');
  await page.waitForSelector('.graph-svg-host svg g circle', { timeout: 15_000 });
  // alpha/beta/gamma + ghost 死链 = 4 节点 × 3 圆
  const circles = page.locator('.graph-svg-host svg g circle');
  expect(await circles.count()).toBeGreaterThanOrEqual(12);
});

test('dead link nodes render as hollow dashed circles', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  const ghost = nodeCircle(page, String.raw`ghost \(\?\)`);
  await expect(ghost).toHaveAttribute('stroke-dasharray', /4 3/);
});

test('single click selects node and shows floating card; close hides it', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  await nodeCircle(page, 'alpha').click();
  const card = page.locator('[data-testid="graph-node-card"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).toContainText('alpha');
  await page.locator('[data-testid="graph-card-close"]').click();
  await expect(card).toBeHidden();
});

test('double click opens the document in knowledge base', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  await nodeCircle(page, 'alpha').dblclick();
  await page.waitForURL('**/knowledge**', { timeout: 5000 });
});

test('focus from card pivots to ego view; chip exit returns to overview', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  await nodeCircle(page, 'alpha').click();
  await page.locator('[data-testid="graph-card-focus"]').click();
  const chip = page.locator('[data-testid="graph-ego-chip"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('alpha');
  await page.locator('[data-testid="graph-ego-exit"]').click();
  await expect(chip).toBeHidden();
});

test('shift+click on overview pivots (bloom falls back when nothing new)', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  await nodeCircle(page, 'alpha').click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-testid="graph-ego-chip"]')).toBeVisible();
});

test('search locates a node and selects it on the canvas', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  await page.locator('[data-testid="graph-search-input"]').fill('gam');
  const list = page.locator('[data-testid="graph-search-list"]');
  await expect(list).toContainText('gamma');
  await page.locator('[data-testid="graph-search-input"]').press('Enter');
  const card = page.locator('[data-testid="graph-node-card"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).toContainText('gamma');
});

test('hover highlight takes priority over selection (no combined focus)', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  // 选中 alpha：其连边高亮
  await nodeCircle(page, 'alpha').click();
  const alphaGhost = page.locator('line[data-source="alpha.md"][data-target="__dead__ghost"], line[data-source="__dead__ghost"][data-target="alpha.md"]').first();
  await expect(alphaGhost).toHaveAttribute('stroke-opacity', '0.9');
  // hover beta 后：高亮只跟随 beta，alpha-ghost 边应回落为暗态
  await nodeCircle(page, 'beta').hover();
  await expect(alphaGhost).toHaveAttribute('stroke-opacity', '0.08', { timeout: 3000 });
  const betaGamma = page.locator('line[data-source="beta.md"][data-target="gamma.md"], line[data-source="gamma.md"][data-target="beta.md"]').first();
  await expect(betaGamma).toHaveAttribute('stroke-opacity', '0.9');
});

test('dragging a node onto another triggers collision separation', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  const alpha = nodeCircle(page, 'alpha');
  const beta = nodeCircle(page, 'beta');
  const aBox = (await alpha.boundingBox())!;
  const bBox = (await beta.boundingBox())!;
  await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2, { steps: 8 });
  await page.mouse.up();
  // 松手后碰撞收尾推开（reheat 0.15，约 1-2s 衰减）
  await page.waitForTimeout(2500);
  const centers = await page.evaluate(() => {
    const gs = Array.from(document.querySelectorAll('.graph-svg-host svg g')).filter(
      (g) => g.querySelector(':scope > circle') && g.querySelector(':scope > text'),
    );
    const out: Record<string, [number, number]> = {};
    for (const g of gs) {
      const label = g.querySelector('text')?.textContent ?? '';
      const m = g.getAttribute('transform')?.match(/-?[\d.]+/g);
      if (m) out[label] = [+m[0], +m[1]];
    }
    return out;
  });
  const [ax, ay] = centers['alpha'];
  const [bx, by] = centers['beta'];
  const dist = Math.hypot(ax - bx, ay - by);
  // 半径各约 12.4 + PAD 4 → 分离下限约 28.8，留容差断言 > 24
  expect(dist).toBeGreaterThan(24);
});

test('node size slider live-updates circle radius', async ({ page }) => {
  await page.goto('/graph');
  await waitForSettle(page);
  const circle = nodeCircle(page, 'alpha');
  const before = Number(await circle.getAttribute('r'));
  await page.locator('.graph-settings-btn').click();
  await page.locator('.graph-settings__tab', { hasText: '外观' }).click();
  const slider = page.locator('.graph-settings__range').first();
  await slider.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, '2');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const after = Number(await circle.getAttribute('r'));
  expect(after).toBeGreaterThan(before);
});
