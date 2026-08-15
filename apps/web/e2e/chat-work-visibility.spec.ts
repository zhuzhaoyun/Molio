/**
 * @area chat
 * @priority P1
 * 工作可见性三件套（方向 A/B/D）：
 *   - WorkTimeline 运行中显示步骤、完成后全部打勾
 *   - SourceChips 出现引用文件 chips，点击跳转打开
 *   - WorkCompleteBanner 完成后展示产物，点击跳转
 * Prerequisites: `pnpm dev`.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, SCRIPTS, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB chat — work visibility', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-work-visibility');
    fs.mkdirSync(path.join(vault.path, '笔记'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, '笔记', '入门.md'), '# 入门笔记\n');
    fs.mkdirSync(path.join(vault.path, '产出'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, '产出', '总结.md'), '# 总结\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  function openQaAndSend(page: import('@playwright/test').Page, text: string) {
    return (async () => {
      await page.locator('[data-testid="kb-btn-ask"]').click();
      const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
      await input.fill(text);
      await page.locator('[data-testid="composer-send"]').click();
    })();
  }

  test('WorkTimeline 运行中显示步骤、完成后全部打勾', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.workflowRun, frameDelay: 300 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await openQaAndSend(page, '总结知识库');

    // 运行中：步骤条出现，且有步骤处于 running 状态
    const timeline = page.locator('[data-testid="work-timeline"]');
    await expect(timeline).toBeVisible({ timeout: 5_000 });
    await expect(timeline).toContainText('读取文件');
    await expect(timeline).toContainText('笔记/入门.md');
    await expect(timeline.locator('[data-step-status="running"]').first()).toBeVisible({ timeout: 5_000 });

    // 完成后：全部步骤打勾（无 running 残留）
    await expect(timeline.locator('[data-step-status="running"]')).toHaveCount(0, { timeout: 10_000 });
    const done = timeline.locator('[data-step-status="done"]');
    await expect(done).toHaveCount(4); // 读取文件 + 检索内容 + 写入文件 + 生成回复
  });
});
