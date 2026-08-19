import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';
import { createTempVault, cleanupTempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P1
 *
 * 会话产出聚合面板（主页 dock）——整个会话写入的 KB 文件 + 来源 rollup。
 * 纯前端聚合（aggregateSessionOutput）；触及 HomePage.tsx / icons.tsx →
 * 全量 E2E 门禁；CLAUDE.md「UI 改动与 E2E 同 commit」。
 */

// Write 产物 1 个 + WebSearch 来源 2 个（URL 去重后）
const outputRun = [
  { type: 'status', label: 'running' },
  { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '产出/总结.md' } },
  { type: 'tool_result', toolUseId: 'w1', content: '已写入', isError: false },
  { type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: '今日科技新闻' } },
  { type: 'tool_result', toolUseId: 'ws1', content: '英伟达 https://www.ithome.com/a\n小米 https://36kr.com/p/1', isError: false },
  { type: 'text_delta', delta: '已整理完毕。' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 400, output_tokens: 60 }, costUsd: 0.02 },
];

test.describe('Home 会话产出面板', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('dock 默认关闭；toggle 打开后聚合写入/来源/stats', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    // 默认关闭：面板不在 DOM
    await expect(page.locator('[data-testid="session-output-panel"]')).toHaveCount(0);
    await sendMessage(page, '整理产出');
    // 完成态：有工具 → hasWorkBlock → 工作块折叠摘要头
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    // toggle 打开
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    await expect(panel).toBeVisible();
    // 写入 1 项（label=basename 总结.md）
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-write"]')).toContainText('总结.md');
    // 来源 2 项（URL）
    await expect(panel.locator('[data-testid="session-output-source"]')).toHaveCount(2);
    // stats 行
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('写入 1 · 来源 2 · 1 轮');
  });

  test('跨消息聚合去重：两轮 Write 同路径 + 同来源 → 各只显示一次', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    await sendMessage(page, '第一轮');
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    await sendMessage(page, '第二轮');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    // writes/sources 各自跨消息去重 → 仍 1 项 / 2 项；turns=2
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-source"]')).toHaveCount(2);
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('2 轮');
  });

  test('点击写入项跳转知识库打开文件', async ({ page }) => {
    const vault = await createTempVault('e2e-dock-nav');
    try {
      // 真实 vault 存在 → vaultStore 保留该 id → 写入项可点
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vault.id);
      await mockChatRun(page, { script: outputRun });
      await gotoHome(page);
      await sendMessage(page, '整理产出');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="home-output-toggle"]').click();
      await page.locator('[data-testid="session-output-write"]').click();
      await page.waitForURL(/\/knowledge/);
    } finally {
      await cleanupTempVault(vault);
    }
  });

  test('无产出会话显示空态', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.simpleTextReply });
    await gotoHome(page);
    await sendMessage(page, '纯问答');
    // 无工具 → 无工作块 → 完成态信号用独立 usage-footer
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    await expect(panel.locator('[data-testid="session-output-empty"]')).toBeVisible();
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid="session-output-source"]')).toHaveCount(0);
  });
});
