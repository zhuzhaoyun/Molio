/**
 * @area kb
 * @priority P1
 * KB 全文搜索：入口（tab 栏常驻按钮 / Ctrl+F）+ 面板交互（ESC 关闭、点结果复用标签）
 * + FTS5 换实现后的行为保持（出结果、按相关性排序、点击打开）。
 * 前置：pnpm dev（daemon :3100 + web :5173，洁净 MOLIO_DATA_DIR；
 * MOLIO_E2E_DAEMON_PORT 平移兼容见 helpers/cleanup.ts 头注）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB Full-text Search', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-search');
    fs.writeFileSync(path.join(vault.path, 'a.md'), '# A\n讨论了微服务拆分的三种方案\n');
    fs.writeFileSync(path.join(vault.path, 'b.md'), '# B\n今天天气不错\n');
    // 相关性排序用：c.md 词频高、d.md 词频低（查询须 ≥3 字才走 FTS5 bm25）
    fs.writeFileSync(path.join(vault.path, 'c.md'), '# C\n信用卡盗刷信用卡盗刷信用卡盗刷专题\n');
    fs.writeFileSync(path.join(vault.path, 'd.md'), '# D\n顺带提到信用卡盗刷一次\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('search button shows matching file and opens it', async ({ page }) => {
    // 先打开非匹配文件 b.md，再搜索匹配 a.md，证明点击真的会切换文件
    await page.goto(`/knowledge?vault=${vault.id}&file=b.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Search is a direct toolbar button now (not buried in the `···` menu)
    await page.locator('[data-testid="kb-btn-search"]').click();

    const panel = page.locator('[data-testid="kb-search-panel"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="kb-search-input"]').fill('拆分');
    // 等结果
    await expect(panel.locator('[data-testid="kb-search-result"]')).toHaveCount(1, { timeout: 5_000 });
    await expect(panel.locator('[data-testid="kb-search-result"]')).toContainText('a.md');

    // 点击结果打开文件 —— 复用当前标签（b.md 被回收，标签数不变）
    await panel.locator('[data-testid="kb-search-result"]').click();
    await expect(panel).not.toBeVisible();
    await expect(page.locator('.kb-wtab.is-active .kb-wtab-title')).toContainText('a.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1);
  });

  test('Ctrl+F opens search panel; ESC closes it', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=a.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('[data-testid="kb-search-panel"]')).toBeVisible();
    // ESC 关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="kb-search-panel"]')).not.toBeVisible();
  });

  test('search button stays visible in tab bar with no tabs open', async ({ page }) => {
    // Select the vault without opening a file → no tabs, but the global search
    // entry in the tab bar must remain available.
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(0);

    const searchBtn = page.locator('[data-testid="kb-btn-search"]');
    await expect(searchBtn).toBeVisible({ timeout: 5_000 });
    await searchBtn.click();
    await expect(page.locator('[data-testid="kb-search-panel"]')).toBeVisible();
  });

  test('FTS5：按相关性排序（词频高者靠前）+ 点击打开', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=b.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('ControlOrMeta+f');
    const input = page.locator('[data-testid="kb-search-input"]');
    await expect(page.locator('[data-testid="kb-search-panel"]')).toBeVisible();
    await input.fill('信用卡盗刷');

    // 两条结果、词频高的 c.md 在前
    const results = page.locator('[data-testid="kb-search-result"]');
    await expect(results).toHaveCount(2, { timeout: 10_000 });
    await expect(results.first()).toContainText('c.md');

    // 点击打开：面板关、主内容区加载 c.md
    await results.first().click();
    await expect(page.locator('[data-testid="kb-search-panel"]')).not.toBeVisible();
    await expect(page.locator('.kb-header-filename-center')).toHaveText('c.md', { timeout: 10_000 });
  });
});
