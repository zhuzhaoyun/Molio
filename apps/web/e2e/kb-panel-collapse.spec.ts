import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { ensureLoggedOut } from './helpers/auth';

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

  test('collapse button folds the panel into a spine rail; expand restores it', async ({ page, request }) => {
    // 上架按钮断言要求「未登录」前提：daemon 会话是服务端全局的（见 helpers/auth），
    // 必须显式登出，再进页面（authStore 首次拉取即拿到登出态，按钮全程不渲染）。
    await ensureLoggedOut(request);
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });

    // 默认展开：折叠按钮可见、树可见、书脊隐藏
    const collapseBtn = page.locator('[data-testid="kb-btn-panel-collapse"]');
    await expect(collapseBtn).toBeVisible({ timeout: 10_000 });
    const panel = page.locator('.kb-file-panel');
    // 本 spec 全程未登录 → 上架按钮按权限不渲染（门控显隐，无分流 UI）
    await expect(page.locator('[data-testid="kb-btn-publish-vault"]')).toHaveCount(0);
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
    // 几何断言必须 poll：满载 runner 上一次性采样会打到折叠动画的过渡帧（CI 实抓
    // 52.4px vs <40 红——本 spec 进 affected 池后与图谱重 spec 并跑，机器负载升高）
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 99, { timeout: 5000 })
      .toBeLessThan(40);

    // 折叠态切库：书脊库名是切库入口——点击打开仓库管理器，面板保持折叠
    const spineName = page.locator('[data-testid="kb-spine-name"]');
    await expect(spineName).toBeVisible();
    await spineName.click();
    await expect(page.locator('[data-testid="vault-manager-modal"]')).toBeVisible();
    await expect(panel).toHaveClass(/kb-file-panel--collapsed/); // 没被连带展开
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="vault-manager-modal"]')).toBeHidden();

    await expandBtn.click();

    // 展开态恢复：书脊让位隐藏，折叠按钮回来、树可见、面板回到正常宽度
    await expect(spine).toBeHidden();
    await expect(page.locator('[data-testid="kb-btn-panel-collapse"]')).toBeVisible();
    await expect(page.locator('.kb-tree-scroll')).toBeVisible();
    // 同上：展开动画同理 poll（对称加固，别等它咬人）
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 5000 })
      .toBeGreaterThan(100);
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

  // 折叠态拖放：书脊只有 28px 宽，横排「释放到根目录」文本会溢出——指示器必须
  // 换成无文字的整条高亮形态；行为保留（拖到书脊 = 导入当前库根目录）。
  test('collapsed spine takes a drop import with a textless full-rail indicator', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="kb-btn-panel-collapse"]').click();
    await expect(page.locator('[data-testid="kb-panel-spine"]')).toBeVisible();

    // dragenter → 面板进入 drag-over-root，且折叠态的 ::after 是空 content（整条高亮形态）
    await page.evaluate(() => {
      const panel = document.querySelector('.kb-file-panel');
      if (!panel) return;
      const dt = new DataTransfer();
      dt.items.add(new File(['# dropped on spine'], 'spine-drop.md', { type: 'text/markdown' }));
      panel.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(page.locator('.kb-file-panel')).toHaveClass(/drag-over-root/, { timeout: 5_000 });
    const indicatorContent = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.kb-file-panel') as Element, '::after').content);
    expect(indicatorContent).toBe('""'); // 展开态此处是 '"释放到根目录"'——折叠态必须无文字

    // drop → 导入当前库；展开后文件在树里
    await page.evaluate(() => {
      const panel = document.querySelector('.kb-file-panel');
      if (!panel) return;
      const dt = new DataTransfer();
      dt.items.add(new File(['# dropped on spine'], 'spine-drop.md', { type: 'text/markdown' }));
      panel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await page.locator('[data-testid="kb-btn-panel-expand"]').click();
    await expect(
      page.locator('.kb-tree-item .kb-tree-name').filter({ hasText: 'spine-drop.md' }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
