import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import { createProject, createConversation, addMessage, deleteProject, createTempVault, cleanupTempVault } from './helpers/cleanup';

/**
 * @area chat
 * @priority P1
 *
 * 历史会话产出恢复：tools 随 assistant 消息持久化（onTurnComplete 落库）后，
 * 从历史记录点开旧会话，产出面板应恢复写入列表与溯源定位（不再「刷新即逝」）。
 * 真实后端造数据：assistant 消息带 tools（绝对路径形态）经同一条生产持久化路径
 * （PUT message → upsertMessage → events_json → listMessages 解析）。
 *
 * 路径必须落在当前活跃 vault 内：产出面板按「库内文档」分流，库外绝对路径会被
 * 判为 hidden 而整体不出现（这正是本次改动的行为）。
 */
const OUTSIDE_MEMORY_PATH = '/tmp/molio-e2e-outside/memory/MEMORY.md';
test('从历史打开会话 → 产出面板恢复写入列表 + 溯源定位', async ({ page }) => {
  const vault = await createTempVault('e2e-histout');
  const project = await createProject(`e2e-histout-${Date.now()}`);
  const conv = await createConversation(project.id, '历史产出恢复');
  const now = Date.now();
  const newsAbs = `${vault.path}/wiki/2026-08-27-新闻要点.md`;
  const hotAbs = `${vault.path}/wiki/hot.md`;
  await addMessage(project.id, conv.id, {
    id: `u-${now}`, role: 'user', content: '搜集今天的 AI 新闻并归档', timestamp: now - 60_000,
  });
  await addMessage(project.id, conv.id, {
    id: `a-${now}`, role: 'assistant', content: '已归档完成。', timestamp: now,
    runId: 'hist-run-1',
    tools: [
      { id: 'hw1', name: 'Write', input: { file_path: newsAbs }, status: 'done', result: '已写入' },
      // 登记元文件（hot.md）—— 恢复后应落折叠区，不冒充产出
      { id: 'hw2', name: 'Edit', input: { file_path: hotAbs }, status: 'done', result: '已更新' },
      // 库外写入（agent 自己的 memory）—— 恢复后也不得出现在面板
      { id: 'hw3', name: 'Write', input: { file_path: OUTSIDE_MEMORY_PATH }, status: 'done', result: '已写入' },
    ],
  });

  try {
    await page.addInitScript((id) => { localStorage.setItem('molio.activeVaultId', id); }, vault.id);
    await gotoHome(page);
    await clickNav(page, 'history');
    await page.locator('[data-testid="history-refresh"]').click();
    const row = page.locator('.history-row__main').first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.click();

    // 会话恢复到整页对话：assistant 消息带持久化的 tools 渲染
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(1);

    // readFile 内容拦截（磁盘上并无该文件；此处只验证 UI 链路）
    await page.route('**/api/knowledge/vaults/*/files/**', (route) =>
      route.fulfill({ json: { path: newsAbs, content: '# 新闻要点\n\n历史会话的产物正文', size: 10, modifiedAt: Date.now() } }));

    // 打开产出 dock → 写入列表从持久化 tools 恢复
    await page.locator('[data-testid="home-output-toggle"]').click();
    const panel = page.locator('[data-testid="session-output-panel"]');
    // 主列表只余产出文档：hot.md（登记元文件）落折叠区、库外写入（hw3）不恢复
    await expect(panel.locator('[data-testid="session-output-write"]')).toHaveCount(1);
    await expect(panel.locator(`[data-path="${newsAbs}"]`)).toHaveAttribute('data-kind', 'create');
    await expect(panel.locator('[data-testid="session-output-stats"]')).toContainText('写入 1 · 1 轮');
    await expect(panel.locator('[data-testid="session-output-others-toggle"]')).toContainText('其他写入 1 项');
    await expect(panel.locator('[data-testid="session-output-write"]').filter({ hasText: 'hot.md' })).toHaveCount(0);
    await expect(panel.locator(`[data-path="${OUTSIDE_MEMORY_PATH}"]`)).toHaveCount(0);
    await expect(panel).not.toContainText('MEMORY.md');

    // 溯源定位：展开历史消息的工作块并闪烁目标工具步
    await panel.locator('[data-testid="session-output-write"]').first().hover();
    await panel.locator('[data-testid="session-output-locate"]').first().click();
    const target = page.locator('.work-block-detail [data-tool-id="hw1"]');
    await expect(target).toBeVisible({ timeout: 5_000 });
    await expect(target).toHaveClass(/evidence-flash/);
  } finally {
    await deleteProject(project.id);
    await cleanupTempVault(vault);
  }
});
