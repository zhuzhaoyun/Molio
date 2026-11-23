import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb-import
 * @priority P1
 *
 * 文件面板（知识库目录栏）折叠/展开开关。
 *
 * 背景：工具栏右端的「发布到资源库」按钮（功能未对非管理员开放，点击只会被
 * 门禁分流到官网）移除后，原位置换成目录栏折叠开关——折叠后留一条「书脊」
 * 细竖条：顶部展开按钮 + 竖排知识库名（用户知道当前库被折叠了、以及是哪个库），
 * 整条可点击展开；折叠/展开有宽度过渡动画；状态持久化到 localStorage。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB file panel collapse/expand', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-panel-collapse');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('collapse button folds the panel into a spine rail; expand restores it', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });

    // 默认展开：折叠按钮可见、树可见、书脊隐藏
    const collapseBtn = page.locator('[data-testid="kb-btn-panel-collapse"]');
    await expect(collapseBtn).toBeVisible({ timeout: 10_000 });
    const panel = page.locator('.kb-file-panel');
    await expect(panel).not.toHaveClass(/kb-file-panel--collapsed/);
    await expect(page.locator('.kb-tree-scroll')).toBeVisible();
    const spine = page.locator('[data-testid="kb-panel-spine"]');
    await expect(spine).toBeHidden();

    await collapseBtn.click();

    // 折叠态：书脊可见（展开按钮 + 竖排库名），树隐藏，面板宽度收窄到竖条宽度
    const expandBtn = page.locator('[data-testid="kb-btn-panel-expand"]');
    await expect(expandBtn).toBeVisible();
    await expect(spine).toBeVisible();
    // 书脊显示当前库名——用户看得出「哪个库被折叠了」
    await expect(spine).toContainText('e2e-panel-collapse');
    await expect(panel).toHaveClass(/kb-file-panel--collapsed/);
    await expect(page.locator('.kb-tree-scroll')).toBeHidden();
    const collapsedBox = await panel.boundingBox();
    expect(collapsedBox?.width ?? 99).toBeLessThan(40);

    await expandBtn.click();

    // 展开态恢复：书脊让位隐藏，折叠按钮回来、树可见、面板回到正常宽度
    await expect(spine).toBeHidden();
    await expect(page.locator('[data-testid="kb-btn-panel-collapse"]')).toBeVisible();
    await expect(page.locator('.kb-tree-scroll')).toBeVisible();
    const expandedBox = await panel.boundingBox();
    expect(expandedBox?.width ?? 0).toBeGreaterThan(100);
  });

  test('collapsed state persists across reload', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="kb-btn-panel-collapse"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="kb-btn-panel-collapse"]').click();
    await expect(page.locator('[data-testid="kb-panel-spine"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });

    // 重载后仍是折叠态
    await expect(page.locator('[data-testid="kb-panel-spine"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.kb-file-panel')).toHaveClass(/kb-file-panel--collapsed/);
    await expect(page.locator('.kb-tree-scroll')).toBeHidden();

    // 收尾展开（每个测试独立 context，localStorage 不跨测试泄漏；此步是双重保险）
    await page.locator('[data-testid="kb-btn-panel-expand"]').click();
    await expect(page.locator('[data-testid="kb-btn-panel-collapse"]')).toBeVisible();
  });
});
