import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * 中文输入法防护：IME 组词中按 Enter 确认候选词时（keydown 带
 * isComposing=true / keyCode 229），不得把带拼音半成的消息发出去。
 * 复现：dispatch keydown(Enter, isComposing:true) → 不应触发发送；
 * 随后正常 Enter → 正常发送。
 *
 * Prerequisites: `pnpm dev` running（daemon + web）。
 */

test.describe('Chat — composer IME guard', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('组词中的 Enter 不发送，确认后正常 Enter 发送', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);

    const input = page.getByTestId('composer-input');
    await input.fill('帮我整理这篇笔记');
    await expect(page.getByTestId('composer-send')).toBeEnabled();

    // 模拟 IME 组词中的 Enter（isComposing=true，keyCode 229）
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
    // 未触发发送：无 run 请求、输入未被清空
    await page.waitForTimeout(600);
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(input).toHaveValue('帮我整理这篇笔记');

    // 正常 Enter → 发送
    await input.press('Enter');
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText(
      'Hello, how can I help you?', { timeout: 10_000 },
    );
  });
});
