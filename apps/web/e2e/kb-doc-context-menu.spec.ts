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
