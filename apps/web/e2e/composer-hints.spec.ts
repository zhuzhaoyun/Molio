import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Composer 提示的归属演进：
 *   v1 常显提示行 → v2 ? 图标 hover 浮层 → v3 @ 与 / 内嵌 placeholder，
 *   ? 图标移除（与历史时钟图标形似易混，且 Enter/Shift+Enter 属通用惯例）。
 *
 * Prerequisites: `pnpm dev` running（daemon + web）。
 */

test.describe('Chat — composer hints', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('@ 与 / 提示内嵌 placeholder（空输入时天然可见）', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);

    const input = page.getByTestId('composer-input');
    await expect(input).toHaveAttribute('placeholder', /@ 引用文件/);
    await expect(input).toHaveAttribute('placeholder', /调用技能/);
  });

  test('? 指引图标与常显提示行均已移除', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);

    // 回归保护：? 图标（与历史时钟形似）与旧常显 .composer-hint 行不再出现
    await expect(page.getByTestId('composer-keys-trigger')).toHaveCount(0);
    await expect(page.locator('.composer-hint')).toHaveCount(0);
    // 左簇只剩 [+ 图片] [历史]
    await expect(page.getByTestId('composer-upload-btn')).toBeVisible();
    await expect(page.getByTestId('composer-history-btn')).toBeVisible();
  });
});
