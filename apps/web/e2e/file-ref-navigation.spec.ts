import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, type MockRunOptions } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * E2E tests for wikilinks in assistant messages rendered on the home page.
 *
 * A scripted assistant reply (via mockChatRun) is used so the tests exercise
 * the real markdown renderer deterministically — they no longer depend on a
 * live AI agent actually emitting a [[wikilink]], which is what made the old
 * real-chat version skip (or time out) on a runtime-less CI runner.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const wikilinkReply = [
  { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
  { type: 'text_delta', delta: '请查看 [[notes/test-file.md]] 这个文件。' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 }, costUsd: 0.001 },
] as const;

const styleCheckReply = [
  { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
  { type: 'text_delta', delta: '收到 [[test/style-check.md]]，好的。' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 }, costUsd: 0.001 },
] as const;

async function mockWikilinkRun(page: Parameters<typeof mockChatRun>[0], opts: Pick<MockRunOptions, 'script'>) {
  await mockChatRun(page, opts);
  await gotoHome(page);
  await sendMessage(page, '请返回一个包含 wikilink 的回复');
  await page.locator('[data-testid="assistant-message"]').last().waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('File reference navigation', () => {
  test('wikilinks in assistant messages have data-file-path attribute', async ({ page }) => {
    await mockWikilinkRun(page, { script: wikilinkReply });

    // The scripted reply always contains [[notes/test-file.md]], so the rendered
    // wikilink must expose the data-file-path attribute for click navigation.
    const wikiLink = page.locator('[data-testid="assistant-prose"] .kb-wiki-link').first();
    await expect(wikiLink).toBeVisible();
    await expect(wikiLink).toHaveAttribute('data-file-path', 'notes/test-file.md');

    // With a data-file-path, the link is clickable → cursor: pointer.
    const cursor = await wikiLink.evaluate((el) => window.getComputedStyle(el).cursor);
    expect(cursor).toBe('pointer');
  });

  test('wikilinks have proper styling', async ({ page }) => {
    await mockWikilinkRun(page, { script: styleCheckReply });

    // Rendered wikilink should be styled as an actionable link (cursor pointer).
    const wikiLink = page.locator('[data-testid="assistant-prose"] .kb-wiki-link').first();
    await expect(wikiLink).toBeVisible();
    await expect(wikiLink).toHaveAttribute('data-file-path', 'test/style-check.md');
    const cursor = await wikiLink.evaluate((el) => window.getComputedStyle(el).cursor);
    expect(cursor).toBe('pointer');
  });
});
