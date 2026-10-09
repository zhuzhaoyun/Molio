import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Assistant prose markdown rendering (lightweight renderer in
 * src/utils/markdown.ts — NOT the KB doocs/md pipeline).
 *
 * Regression: h4–h6 headings (`#### …`) used to render as literal text
 * because the chat renderer only handled `#`–`###` (reported with
 * `#### 方案 A：…` showing raw hashes in the dialog).
 */

const HEADINGS_REPLY = [
  { type: 'status', label: 'running' },
  {
    type: 'text_delta',
    delta: [
      '**三、方案选项**',
      '',
      '#### 方案 A：最小清理（保守）',
      '',
      '- 删除重复条目',
      '- 不动整体结构',
      '',
      '#### 方案 B：结构化重组',
      '',
      '正文段落。',
    ].join('\n'),
  },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
];

const ALL_LEVELS_REPLY = [
  { type: 'status', label: 'running' },
  {
    type: 'text_delta',
    delta: '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n',
  },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
];

test.describe('Chat — markdown headings', () => {
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('h4 headings render as elements, not literal #### text', async ({ page }) => {
    await mockChatRun(page, { script: HEADINGS_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'show options');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    // Two h4 elements with the option titles
    await expect(prose.locator('h4')).toHaveCount(2);
    await expect(prose.locator('h4').first()).toHaveText('方案 A：最小清理（保守）');
    await expect(prose.locator('h4').nth(1)).toHaveText('方案 B：结构化重组');

    // No literal hash markers leak into the rendered output
    await expect(prose).not.toContainText('####');

    // Bold and list still render alongside the headings
    await expect(prose.locator('strong')).toHaveText('三、方案选项');
    await expect(prose.locator('ul li')).toHaveCount(2);
  });

  test('h1–h6 all render as heading elements', async ({ page }) => {
    await mockChatRun(page, { script: ALL_LEVELS_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'show headings');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    for (let level = 1; level <= 6; level++) {
      await expect(prose.locator(`h${level}`)).toHaveText(`H${level}`);
    }
    await expect(prose).not.toContainText('#');
  });
});
