import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * E2E tests for SSE event rendering details: thinking blocks, tool use, errors.
 *
 * Each test uses a specific script that exercises different event types.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Chat — streaming details', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('thinking block renders and is collapsible', async ({ page }) => {
    // frameDelay 拉宽流式窗口：默认瞬时 flush 会让 run 在 Playwright 轮询到前就完成，
    // 完成态思考块收进折叠工作块不在 DOM，抓不到「流式自动展开」。
    await mockChatRun(page, { script: SCRIPTS.withThinking, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, 'Analyze this');

    // 流式时：思考块在 WorkBlock 内自动展开，内容可见
    const thinking = page.locator('[data-testid="thinking-block"]');
    await expect(thinking).toBeVisible({ timeout: 10_000 });
    await expect(thinking.locator('.thinking-header')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toContainText('Let me analyze this...');

    // 完成后：思考块收进折叠的工作块详情（默认收起），需先展开工作块再展开思考块
    const summary = page.locator('[data-testid="work-timeline-summary"]');
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await summary.click();
    await expect(thinking.locator('.thinking-content')).toBeHidden();

    // 点击思考块标题 → 展开
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toContainText('Let me analyze this...');

    // 再次点击 → 折叠
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeHidden();
  });

  test('tool use renders inline with name and status', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    // Wait for the response to complete
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });

    // 完成后工具行收进折叠的工作块，展开后可见（单工具不分组，直接 .tool-line）
    await page.locator('[data-testid="work-timeline-summary"]').click();
    const toolLine = page.locator('.tool-line');
    await expect(toolLine).toBeVisible();
    await expect(toolLine.locator('.tool-line-name')).toContainText('Read');

    // Status should show done (✓)
    await expect(toolLine.locator('.tool-line-status')).toContainText('✓');
  });

  test('assistant prose contains text before and after tool use', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    // Script emits: "Let me check that file." → tool_use → " The file looks good."
    await expect(prose).toContainText('Let me check that file.');
    await expect(prose).toContainText('The file looks good.');
  });

  test('error event shows in assistant message', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withError });
    await gotoHome(page);
    await sendMessage(page, 'Trigger error');

    // Wait for assistant message to render
    const assistantMsg = page.locator('[data-testid="assistant-message"]');
    await expect(assistantMsg).toBeVisible({ timeout: 10_000 });

    // Error text should appear in the message
    await expect(assistantMsg).toContainText('Something went wrong', { timeout: 5_000 });
  });
});
