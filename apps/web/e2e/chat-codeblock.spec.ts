import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Code block rendering: language label, copy, fold.
 */

const CODE_REPLY = [
  { type: 'status', label: 'running' },
  { type: 'text_delta', delta: 'Here is code:\n\n```ts\nconst x: number = 1;\nconsole.log(x);\n```\n' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
];

test.describe('Chat — code block', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (t: string) => { (window as any).__copied = t; } },
        configurable: true,
      });
    });
  });

  test('shows language label and copy button', async ({ page }) => {
    await mockChatRun(page, { script: CODE_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'show code');
    await expect(page.locator('[data-testid="codeblock"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="codeblock-lang"]')).toHaveText('ts');
    await expect(page.locator('[data-testid="codeblock-copy-btn"]')).toBeVisible();
  });

  test('copy button copies raw code', async ({ page }) => {
    await mockChatRun(page, { script: CODE_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'show code');
    await page.locator('[data-testid="codeblock-copy-btn"]').click();
    const copied = await page.evaluate(() => (window as any).__copied as string);
    expect(copied).toContain('const x: number = 1');
    expect(copied).not.toContain('```');
  });

  test('long code is folded by default and can expand', async ({ page }) => {
    const longBody = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const longReply = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: '```js\n' + longBody + '\n```\n' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await mockChatRun(page, { script: longReply });
    await gotoHome(page);
    await sendMessage(page, 'long code');
    await expect(page.locator('[data-testid="codeblock-expand-btn"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="codeblock-expand-btn"]')).toContainText('展开');
    await page.locator('[data-testid="codeblock-expand-btn"]').click();
    await expect(page.locator('[data-testid="codeblock-expand-btn"]')).toContainText('收起');
  });

  test.afterEach(async ({ page }) => { await unmockAll(page); });
});
