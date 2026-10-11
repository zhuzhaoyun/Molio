/**
 * @area kb
 * @priority P1
 * KB 全文搜索（检索 P0 层 1）：FTS5 换实现后，SearchPanel 体验保持——
 * 出结果、按相关性排序（词频高者靠前）、点击结果打开文件。
 * 前置：pnpm dev（daemon :3100 + web :5173，洁净 MOLIO_DATA_DIR，
 * MOLIO_E2E_DAEMON_PORT 平移兼容见 helpers/cleanup.ts 头注）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON = `http://localhost:${Number(process.env.MOLIO_E2E_DAEMON_PORT ?? 3100)}`;
const vaultName = `e2e-search-${Date.now()}`;
let vaultId = '';
let vaultPath = '';

test.beforeAll(async () => {
  vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-search-'));
  const res = await fetch(`${DAEMON}/api/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: vaultPath }),
  });
  vaultId = ((await res.json()) as { id: string }).id;
  // b.md 词频高、a.md 词频低 → 断言 bm25 排序（查询词须 ≥3 字才走 FTS5）
  const seeds: Array<[string, string]> = [
    ['b.md', '信用卡盗刷信用卡盗刷信用卡盗刷专题笔记'],
    ['a.md', '顺带提到信用卡盗刷一次'],
  ];
  for (const [p, content] of seeds) {
    const r = await fetch(
      `${DAEMON}/api/knowledge/vaults/${vaultId}/files/${encodeURIComponent(p)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) },
    );
    if (!r.ok) throw new Error(`seed file failed: ${p} (${r.status})`);
  }
});

test.afterAll(async () => {
  if (vaultId) await fetch(`${DAEMON}/api/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  if (vaultPath) fs.rmSync(vaultPath, { recursive: true, force: true });
});

test('kb 全文搜索：相关性排序 + 点击打开', async ({ page }) => {
  await gotoHome(page);
  // reload 重取 vault 列表（UI store 只在挂载时拉取，同 publish-flow）
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  // 切到测试 vault
  await page.locator('.kb-vault-bar').first().click();
  await page.locator('.vm-vault-item').filter({ hasText: vaultName }).click();
  await page.waitForTimeout(1_000);

  // Ctrl/Cmd+F 开搜索面板，搜「信用卡盗刷」（≥3 字走 FTS5 bm25 排序）
  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByTestId('kb-search-input');
  await expect(input).toBeVisible();
  await input.fill('信用卡盗刷');

  // 两条结果、词频高的 b.md 在前
  const results = page.getByTestId('kb-search-result');
  await expect(results).toHaveCount(2, { timeout: 10_000 });
  await expect(results.first()).toContainText('b.md');

  // 点击打开：面板关、主内容区加载 b.md
  await results.first().click();
  await expect(page.getByTestId('kb-search-panel')).toBeHidden();
  await expect(page.locator('.kb-header-filename-center')).toHaveText('b.md', { timeout: 10_000 });
});
