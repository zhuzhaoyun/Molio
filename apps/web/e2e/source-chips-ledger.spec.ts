/**
 * @area chat
 * @priority P1
 * 引用区台账形态 —— wiki 构建一轮读上百个文件后，消息底部的引用区
 * 「排布杂乱 + 无法折叠」的回归防护。
 *
 * 形态契约：
 *   - ≤ 8 项 → 平铺（与旧形态一致，chip 直接排开）
 *   - \> 8 项 → 台账：标题行带计数（整条可折叠）+ 可查证层（文档 chip）
 *     + 其余层（媒体数据 / 索引日志 / 库外 / 检索路径，各一行计数、按需展开）
 *
 * Prerequisites: `pnpm dev`.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

let vault: TempVault;

/** 造一条「读了 N 个文件」的脚本：前 nDocs 个是 .md 文档，其余是 .png 媒体 */
function readScript(nDocs: number, nMedia: number) {
  const script: unknown[] = [{ type: 'status', label: 'running' }];
  for (let i = 0; i < nDocs; i++) {
    script.push({ type: 'tool_use', id: `d${i}`, name: 'Read', input: { file_path: `笔记/文档${i}.md` } });
    script.push({ type: 'tool_result', toolUseId: `d${i}`, content: '# 内容', isError: false });
  }
  for (let i = 0; i < nMedia; i++) {
    script.push({ type: 'tool_use', id: `m${i}`, name: 'Read', input: { file_path: `媒体/图${i}.png` } });
    script.push({ type: 'tool_result', toolUseId: `m${i}`, content: 'PNG', isError: false });
  }
  script.push({ type: 'text_delta', delta: '已完成。' });
  script.push({ type: 'turn_end', stopReason: 'end_turn' });
  script.push({ type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 });
  return script;
}

test.describe('引用区 — 台账形态', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-source-ledger');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('≤8 项 → 平铺（与旧形态一致，无标题行计数）', async ({ page }) => {
    await mockChatRun(page, { script: readScript(3, 2) });
    await page.goto(`/knowledge?vault=${vault.id}&file=test.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill('读几个文件');
    await page.locator('[data-testid="composer-send"]').click();

    const chips = page.locator('[data-testid="assistant-message"]').last().locator('[data-testid="source-chip"]');
    await expect(chips).toHaveCount(5, { timeout: 10_000 });
    // 平铺形态没有台账标题行
    await expect(page.locator('[data-testid="source-ledger-head"]')).toHaveCount(0);
  });

  test('>8 项 → 台账：文档进可查证层，媒体进其余层；整条与分层都能折叠', async ({ page }) => {
    await mockChatRun(page, { script: readScript(12, 20) });
    await page.goto(`/knowledge?vault=${vault.id}&file=test.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill('读很多文件');
    await page.locator('[data-testid="composer-send"]').click();

    const msg = page.locator('[data-testid="assistant-message"]').last();

    // 台账标题行：带总数
    const head = msg.locator('[data-testid="source-ledger-head"]');
    await expect(head).toBeVisible({ timeout: 10_000 });
    await expect(head).toContainText('32');

    // 可查证层：12 个文档 chip 直接可见
    await expect(msg.locator('[data-testid="source-chip"]')).toHaveCount(12);

    // 其余层：媒体一行计数（不铺开）
    const media = msg.locator('[data-testid="source-ledger-bucket-media"]');
    await expect(media).toBeVisible();
    await expect(media).toContainText('20');

    // 展开媒体层 → 20 个文字条目（不是 chip：过程痕迹不该有按钮的重量）
    await media.click();
    await expect(msg.locator('[data-testid="source-minor-item"]')).toHaveCount(20);

    // 折叠整条 → 全部内容收起，只剩标题行
    await head.click();
    await expect(msg.locator('[data-testid="source-chip"]')).toHaveCount(0);
    await expect(msg.locator('[data-testid="source-minor-item"]')).toHaveCount(0);
    await expect(head).toBeVisible();
  });
});
