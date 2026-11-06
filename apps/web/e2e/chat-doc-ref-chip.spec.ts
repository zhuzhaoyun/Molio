import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area chat
 * @priority P1
 *
 * 从知识库文档进入问答时的「文档引用」交互：
 * 旧行为是把 `@文档路径` 直接种进输入框文本（用户反馈：不希望被自动带上，且
 * 不知道可以删）。新行为改为输入框下方工具条里的可移除引用 chip——
 * 引用是显式对象而非输入文本，一键可摘。
 *
 * 三条核心断言：
 * 1. 打开问答时输入框是**空的**（不再自动塞 @ 文本），chip 显示文档名；
 * 2. 点 × 摘掉 chip 后发送，消息里不带该文档引用；
 * 3. chip 在场时发送，消息里带文档引用（走既有 @ 展开管线）。
 */

let vault: TempVault;

test.describe('Chat — 文档引用 chip', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-doc-ref-chip');
    fs.writeFileSync(path.join(vault.path, '笔记.md'), '# 笔记\n\n内容\n');
    fs.writeFileSync(path.join(vault.path, '另一篇.md'), '# 另一篇\n\n内容\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  async function openAskPanel(page: import('@playwright/test').Page) {
    await mockChatRun(page);
    // 相对路径走 baseURL：不硬编码 web 端口（MOLIO_E2E_WEB_PORT 平移时才不会打空）
    await page.goto(`/knowledge?vault=${vault.id}&file=笔记.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel.locator('[data-testid="composer-input"]')).toBeVisible({ timeout: 5_000 });
    return panel;
  }

  test('打开文档问答：输入框为空，引用以 chip 形式出现在工具条', async ({ page }) => {
    const panel = await openAskPanel(page);

    // 核心：输入框不再被自动种入 @文本
    await expect(panel.locator('[data-testid="composer-input"]')).toHaveValue('');

    // 引用以 chip 呈现，显示文档名（而非完整路径）
    const chip = panel.locator('[data-testid="composer-file-ref"]');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('笔记.md');
    // 完整路径留在 title 上，供悬停确认
    await expect(chip).toHaveAttribute('title', /笔记\.md/);
  });

  test('点 × 摘掉引用后发送：消息里不带该文档', async ({ page }) => {
    const panel = await openAskPanel(page);

    await panel.locator('[data-testid="composer-file-ref-remove"]').click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toHaveCount(0);

    await panel.locator('[data-testid="composer-input"]').fill('这个不引用文档');
    await panel.locator('[data-testid="composer-send"]').click();

    const userMsg = panel.locator('[data-testid="user-message"]').last();
    await expect(userMsg).toBeVisible({ timeout: 10_000 });
    await expect(userMsg).toContainText('这个不引用文档');
    // 摘掉的引用不得出现在消息里（旧实现会把 @路径 一并发出）
    await expect(userMsg).not.toContainText('笔记.md');
  });

  test('保留引用发送：消息里带上该文档', async ({ page }) => {
    const panel = await openAskPanel(page);

    await panel.locator('[data-testid="composer-input"]').fill('解释这篇');
    await panel.locator('[data-testid="composer-send"]').click();

    const userMsg = panel.locator('[data-testid="user-message"]').last();
    await expect(userMsg).toBeVisible({ timeout: 10_000 });
    await expect(userMsg).toContainText('解释这篇');
    await expect(userMsg).toContainText('笔记.md');
  });

  test('摘掉引用后进入全屏态：新挂载的 composer 不重新播种', async ({ page }) => {
    const panel = await openAskPanel(page);

    await panel.locator('[data-testid="composer-file-ref-remove"]').click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toHaveCount(0);

    // 进入全屏态会挂载**另一个** ChatComposer（与面板同一个 composerKey，同一份
    // initialFileRefs）。若引用只存在组件 state 里，这里会重新播种 → 「删了又回来」。
    await panel.locator('[data-testid="kb-chat-fullscreen"]').click();
    // 先等真正落到全屏页（.home-page 而非面板），否则断言可能在面板还没卸载时
    // 就通过——那属于「瞬时窗口上的假绿」。
    await page.waitForURL('**/chat', { timeout: 5_000 });
    const fullscreen = page.locator('.home-page.chat-active');
    await expect(fullscreen).toBeVisible({ timeout: 5_000 });
    await expect(fullscreen.locator('[data-testid="composer-input"]')).toBeVisible();
    await expect(fullscreen.locator('[data-testid="composer-file-ref"]')).toHaveCount(0);
  });

  test('切换打开的文档：引用 chip 跟着切，未发送的草稿留在会话里', async ({ page }) => {
    const panel = await openAskPanel(page);
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toContainText('笔记.md');
    await panel.locator('[data-testid="composer-input"]').fill('还没发的草稿');

    // 只切文档，不再点 💬问答 —— 引用应当跟随当前打开的文档
    await page.locator('.kb-tree-name').filter({ hasText: '另一篇.md' }).click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toContainText('另一篇.md');
    // 草稿按会话保存：文档切换导致的 composer 重挂载不得吞掉没发出去的文字
    await expect(panel.locator('[data-testid="composer-input"]')).toHaveValue('还没发的草稿');
  });

  test('摘掉引用后切到别的文档再切回：该文档的 chip 重新出现', async ({ page }) => {
    const panel = await openAskPanel(page);
    // 在「笔记.md」上摘掉 chip
    await panel.locator('[data-testid="composer-file-ref-remove"]').click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toHaveCount(0);

    // 切到另一篇 → chip 正常播种
    await page.locator('.kb-tree-name').filter({ hasText: '另一篇.md' }).click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toContainText('另一篇.md');

    // 切回「笔记.md」→ 摘除只对上次那次停留有效，重新播种
    await page.locator('.kb-tree-name').filter({ hasText: '笔记.md' }).click();
    await expect(panel.locator('[data-testid="composer-file-ref"]')).toContainText('笔记.md');
  });

  test('发送后引用 chip 清空（与旧的 @文本被清空行为一致）', async ({ page }) => {
    const panel = await openAskPanel(page);

    await panel.locator('[data-testid="composer-input"]').fill('第一条');
    await panel.locator('[data-testid="composer-send"]').click();
    await expect(panel.locator('[data-testid="user-message"]').last()).toBeVisible({ timeout: 10_000 });

    await expect(panel.locator('[data-testid="composer-file-ref"]')).toHaveCount(0);
  });
});
