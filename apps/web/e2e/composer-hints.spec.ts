import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Composer 快捷键提示：不常显（省一行高度），hover / 键盘 focus 时经
 * 「?」图标浮出。原常显提示行已移除。
 *
 * Prerequisites: `pnpm dev` running（daemon + web）。
 */

test.describe('Chat — composer hints', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('提示浮层默认隐藏，hover 图标时浮出', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);

    const trigger = page.getByTestId('composer-keys-trigger');
    await expect(trigger).toBeVisible();
    const tip = page.getByTestId('composer-keys');
    // 默认不可见（visibility:hidden + opacity:0）
    await expect(tip.locator('.composer-keys-tip')).toBeHidden();

    await trigger.hover();
    await expect(tip.locator('.composer-keys-tip')).toBeVisible();
    await expect(tip.locator('.composer-keys-tip')).toContainText('调用技能');
    await expect(tip.locator('.composer-keys-tip')).toContainText('引用文件/目录');
  });

  test('常显提示行已移除', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);

    // 回归保护：旧的常显 .composer-hint 行不应再出现
    await expect(page.locator('.composer-hint')).toHaveCount(0);
    // @ 与 / 提示内嵌 placeholder（workbuddy 式：空输入时天然可见）
    await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', /@ 引用文件/);
    await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', /调用技能/);
  });
});
