import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage, clickNav } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';
import { createTempVault, cleanupTempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P1
 *
 * 会话产出聚合面板（主页 dock）——本次会话 Molio 写入的 KB 文件 rollup。
 * 纯前端聚合（aggregateSessionOutput）；外部引用（读过的文件 / 网页 URL）只在
 * 消息内联 SourceChips 展示，不进产出面板。触及 HomePage.tsx / App.tsx →
 * 全量 E2E 门禁；CLAUDE.md「UI 改动与 E2E 同 commit」。
 */

// Write 产物 1 个 + WebSearch 来源 2 个（来源不再进面板，仅用于验证「外部引用不混入产出」）
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

  test('dock 默认关闭；toggle 打开后聚合写入/stats（外部引用不混入）', async ({ page }) => {
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
    // 外部引用不进面板（来源分区已移除，只在消息内联 SourceChips）
    await expect(panel.locator('[data-testid="session-output-source"]')).toHaveCount(0);
    // stats 行
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('写入 1 · 1 轮');
  });

  test('跨消息聚合去重：两轮 Write 同路径 → 只显示一次', async ({ page }) => {
    await mockChatRun(page, { script: outputRun });
    await gotoHome(page);
    await sendMessage(page, '第一轮');
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    await sendMessage(page, '第二轮');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 15_000 });
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    // writes 跨消息按 path 去重 → 仍 1 项；turns=2
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('2 轮');
  });

  test('点击写入项 → 面板内嵌预览渲染文件内容；返回恢复列表（不跳转知识库）', async ({ page }) => {
    const vault = await createTempVault('e2e-dock-preview');
    try {
      // 真实 vault 存在 → 写入项可点；拦截 readFile 返回 mock 内容（不依赖真实文件落盘）
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vault.id);
      await page.route('**/knowledge/vaults/*/files/**', (route) => {
        return route.fulfill({
          json: {
            path: '产出/总结.md',
            content: '# Mock 预览标题\n\n预览正文内容段落',
            size: 100,
            modifiedAt: Date.now(),
          },
        });
      });
      await mockChatRun(page, { script: outputRun });
      await gotoHome(page);
      await sendMessage(page, '整理产出');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="home-output-toggle"]').click();
      const panel = page.locator('[data-testid="session-output-panel"]');
      // 点击写入项 → 预览视图出现，mock 内容渲染可见
      await panel.locator('[data-testid="session-output-write"]').click();
      await expect(panel.locator('[data-testid="session-output-preview"]')).toBeVisible();
      await expect(panel.locator('[data-testid="session-output-preview"]')).toContainText('Mock 预览标题');
      await expect(panel.locator('[data-testid="session-output-preview"]')).toContainText('预览正文内容段落');
      // 仍在主页（未跳转知识库）—— 不打破对话注意力
      await expect(page).toHaveURL(/\/$/);
      // 返回 → 列表恢复
      await panel.locator('[data-testid="session-output-preview-back"]').click();
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
      await expect(panel.locator('[data-testid="session-output-preview"]')).toHaveCount(0);
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
  });

  test('切换知识库 → 旧 vault 会话被重置（提示 + 消息清空 + 产出面板空态）', async ({ page }) => {
    const vaultA = await createTempVault('e2e-reset-a');
    const vaultB = await createTempVault('e2e-reset-b');
    try {
      await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vaultA.id);
      await mockChatRun(page, { script: outputRun });
      await gotoHome(page);
      await sendMessage(page, '整理产出');
      await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
      // 先确认 vault A 上下文里有产出
      await page.locator('[data-testid="home-output-toggle"]').click();
      const panel = page.locator('[data-testid="session-output-panel"]');
      await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
      // 去知识库页，URL 驱动就地切 vault（KB 页 URL→store effect 触发 setActiveVaultId）
      await clickNav(page, 'knowledge');
      await expect(page.locator('.kb-vault-bar')).toBeVisible();
      await page.evaluate((vid) => {
        window.history.pushState({}, '', `/knowledge?vault=${vid}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, vaultB.id);
      // 跨 vault 会话重置提示出现
      await expect(page.locator('[data-testid="vault-switch-notice"]')).toBeVisible({ timeout: 5_000 });
      // 回主页 → 旧会话已清空：home 回到无对话的 landing 视图，产出面板随之消失
      await clickNav(page, 'home');
      await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
      await expect(page.locator('.home-landing')).toBeVisible();
      await expect(page.locator('[data-testid="session-output-panel"]')).toHaveCount(0);
    } finally {
      await cleanupTempVault(vaultA);
      await cleanupTempVault(vaultB);
    }
  });
});
