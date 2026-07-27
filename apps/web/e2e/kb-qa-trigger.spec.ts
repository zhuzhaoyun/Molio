import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * qa 模式的 wiki-query 确定性触发语（useKbChat WIKI_QUERY_TRIGGER）只应包裹会话首轮：
 * - 首轮 POST /api/runs 的 message 带「（知识库问答：请用 wiki-query skill…）」前缀
 * - 多轮 follow-up POST /api/runs/:id/messages 的 message 为用户原文，不再带触发语
 *
 * 每轮都带前缀会污染对话历史（用户反馈的 bug）。
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('KB qa — wiki-query trigger wraps only the first turn', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-qa-trigger');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test.beforeEach(async ({ page }) => {
    await mockChatRun(page);
  });
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('first question carries the trigger; follow-up is sent verbatim', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Open qa mode (💬问答).
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();
    const input = panel.locator('[data-testid="composer-input"]');

    // ── Turn 1: create-run request must carry the wiki-query trigger ──
    const createRunReq = page.waitForRequest(
      (req) => req.url().includes('/api/runs')
        && req.method() === 'POST'
        && !req.url().includes('/messages'),
      { timeout: 10_000 },
    );
    await input.fill('First question');
    await input.press('Enter');

    const firstBody = (await createRunReq).postDataJSON();
    expect(firstBody.message).toContain('知识库问答');
    expect(firstBody.message).toContain('wiki-query');
    expect(firstBody.message).toContain('First question');
    // Trigger phrase is a prefix — agent sees the directive before the question.
    expect(firstBody.message.indexOf('知识库问答')).toBeLessThan(firstBody.message.indexOf('First question'));

    // Wait for turn 1 to finish (mock SSE turn_end → input unlocks).
    await expect(panel.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
    await expect(input).toBeEnabled({ timeout: 10_000 });

    // ── Turn 2: multi-turn follow-up must NOT carry the trigger ──
    const followUpReq = page.waitForRequest(
      (req) => req.url().includes('/messages') && req.method() === 'POST',
      { timeout: 10_000 },
    );
    await input.fill('Follow-up question');
    await input.press('Enter');

    const secondBody = (await followUpReq).postDataJSON();
    expect(secondBody.message).toContain('Follow-up question');
    expect(secondBody.message).not.toContain('知识库问答');
    expect(secondBody.message).not.toContain('wiki-query');
  });
});
