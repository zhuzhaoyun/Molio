/**
 * @area kb
 * @priority P0
 *
 * 回归：拖选文档内容松手后，选区必须保留（不被 React 重渲染抹掉）。
 * 前置：pnpm dev（daemon :3100 + web :5173）。
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';
const MD = `# Selection Repro

这是一段用来测试选中的中文内容。Another English paragraph here with enough text to drag across.
`;
let vaultPath: string;
let vaultId: string;
const vaultName = `e2e-ctx-${Date.now()}`;
const t_zh_copy = '复制';

test.beforeAll(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), 'molio-ctx-'));
  writeFileSync(join(vaultPath, 'sel-test.md'), MD);
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: vaultPath }),
  });
  vaultId = (await res.json()).id;
});

test.afterAll(async () => {
  if (vaultId) await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  if (vaultPath) rmSync(vaultPath, { recursive: true, force: true });
});

async function openFile(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await clickNav(page, 'knowledge');
  await page.waitForSelector('.kb-shell');
  await page.locator('.kb-vault-bar').first().click();
  await page.waitForTimeout(400);
  await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
  await page.waitForTimeout(800);
  await page.locator('.kb-tree-item').filter({ hasText: 'sel-test.md' }).click();
  await page.waitForSelector('.kb-content-area #output section p', { timeout: 10_000 });
}

test('drag selection survives mouseup', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = await para.boundingBox()!;
  const startX = box.x + 12, endX = box.x + box.width - 12, y = box.y + box.height / 2;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel.length).toBeGreaterThan(0);
});

test('context menu appears with correct items and disabled states', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = await para.boundingBox()!;

  // 先在无选区状态下右键（点击一次放置光标，无选区）
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3_000 });

  // 无选区时：复制与就此提问 disabled；全选 enabled
  await expect(page.locator('.ctx-menu-item', { hasText: '复制' })).toBeDisabled();
  await expect(page.locator('.ctx-menu-item', { hasText: '就此提问' })).toBeDisabled();
  await expect(page.locator('.ctx-menu-item', { hasText: '全选' })).toBeEnabled();

  // 三项都存在
  await expect(page.locator('.ctx-menu-item', { hasText: t_zh_copy })).toBeVisible();
  // 用 data-testid 不可得（ContextMenu 不带 testid），用文本定位
  const items = page.locator('.ctx-menu-item');
  await expect(items).toHaveCount(3);

  // 关闭菜单（ESC）
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toBeHidden();
});

test('copy action writes selection to clipboard', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = await para.boundingBox()!;

  // 拖选
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const selBefore = await page.evaluate(() => window.getSelection()?.toString() ?? '');

  // 右键 → 复制
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '复制' }).click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(selBefore);
});

test('select-all action selects #output content', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = await para.boundingBox()!;

  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '全选' }).click();
  await page.waitForTimeout(200);

  const sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel).toContain('这是一段用来测试选中的中文内容');
});

test('ask-about-selection opens chat with selection preview', async ({ page }) => {
  await openFile(page);
  const para = page.locator('#output section p').first();
  const box = await para.boundingBox()!;

  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const selBefore = await page.evaluate(() => window.getSelection()?.toString() ?? '');

  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '就此提问' }).click();

  await expect(page.locator('[data-testid="kb-chat-panel"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="kb-chat-selected-preview"]')).toContainText(selBefore);
});
