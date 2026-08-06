// apps/web/e2e/kb-chat-sessions.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 * 多会话标签：新建/切换/各自独立消息/运行中切换后台保活/刷新持久化/关闭运行中会话。
 * Prerequisites: `pnpm dev`.
 */

/**
 * 每个会话都常驻一个 .file-chat-messages 容器（空态 .file-chat-empty 也嵌在里面），
 * 多会话共存时必须限定到可见（激活）会话，否则 strict mode 会因命中多个元素而报错。
 */
function activeMessages(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible .file-chat-messages');
}

let vault: TempVault;

test.describe('KB chat sessions', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-sessions');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('多会话：各自独立消息、切换不串台', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 打开问答 → 出现 1 个会话标签
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const tabbar = page.locator('[data-testid="kb-chat-session-tabbar"]');
    await expect(tabbar).toBeVisible();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

    // 会话1 发送独立消息
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('关于 doc.md 的问题');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(activeMessages(page)).toContainText('关于 doc.md 的问题');

    // 新建会话2
    await page.locator('[data-testid="kb-chat-session-new"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    // 会话2 是空的（注意：每个会话都常驻一个 .file-chat-messages 容器，需限定可见会话）
    await expect(page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible .file-chat-empty')).toBeVisible();

    // 切回会话1 → 消息还在
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(activeMessages(page)).toContainText('关于 doc.md 的问题');
  });

  test('运行中切走后台保活，切回看到结果', async ({ page }) => {
    await mockChatRun(page, { frameDelay: 60 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 打开问答面板 → 会话1
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('请生成一篇长文');
    await page.locator('[data-testid="composer-send"]').click();
    // 立即新建会话2（第 1 个还在流式）
    await page.locator('[data-testid="kb-chat-session-new"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    // 等流式结束（5 帧 × 60ms）
    await page.waitForTimeout(400);
    // 切回会话1，应看到完整回复
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(activeMessages(page)).toContainText('Hello,', { timeout: 5_000 });
  });

  test('刷新后会话标签恢复（localStorage 持久化）', async ({ page }) => {
    await mockChatRun(page);
    // 刷新后 KbChatSession 会按 conversationId 从 DB 拉历史；mock 返回空历史，
    // 避免真实 daemon 对未知 conversation 404 → onLoadError 关掉标签。
    await page.route('**/api/conversations/*/messages', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) }));
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('持久化测试');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(activeMessages(page)).toContainText('持久化测试');

    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
  });

  test('关闭运行中会话：后台继续并关闭（不取消 run）', async ({ page }) => {
    // frameDelay 400ms × 5 帧 ≈ 2s 窗口内保持 running，便于操作关闭确认
    await mockChatRun(page, { frameDelay: 400 });
    // 记录对 /api/runs 的 DELETE（= cancelRun）；「后台继续并关闭」不应发出
    let cancelRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/runs/')) cancelRequests++;
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('后台继续测试');
    await page.locator('[data-testid="composer-send"]').click();
    // 等 run 进入 running（header 显示运行状态）再关闭
    await expect(page.locator('[data-testid="kb-chat-panel"] .file-chat-status')).toBeVisible({ timeout: 5_000 });

    // 点会话标签的 × → 关闭确认对话框
    await page.locator('[data-testid="kb-chat-session-tab-close"]').click();
    const dialog = page.locator('.kb-modal', { hasText: '任务正在运行' });
    await expect(dialog).toBeVisible();
    // 选「后台继续并关闭」（tertiary）
    await dialog.locator('.kb-modal-footer button').filter({ hasText: '后台继续并关闭' }).click();

    // 标签关闭；run 未被取消（无 DELETE /api/runs）
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(cancelRequests).toBe(0);
  });

  test('构建中再点构建 → 三选一；中断后新构建开始（cancel 旧 run）', async ({ page }) => {
    // frameDelay 400ms × 5 帧 ≈ 1.2s 内第一个构建保持 running，第二次点击才能命中三选一
    await mockChatRun(page, { frameDelay: 400 });
    // 记录对 /api/runs 的 DELETE（= cancelRun）；「中断并立即执行」必须发出恰好 1 次
    let cancelRequests = 0;
    // 记录 POST /api/runs（= createRun）。中断后新建构必须再 createRun 一次（共 2 次）——
    // 若发送被旧 run 的多轮续传吃掉（mock 的 messages 路由总是 200），或复活旧消息，此断言会失败。
    let createRunRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/runs/')) cancelRequests++;
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/runs')) createRunRequests++;
    });

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 第一次点构建 → ⚙️ 标签创建 + 自动发送；等 run 进入 running（header 显示运行状态）
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="kb-chat-panel"] .file-chat-status')).toBeVisible({ timeout: 5_000 });

    // 构建在跑再点 → 三选一确认框（data-testid=confirm-dialog）
    await page.locator('[data-testid="kb-btn-build-wiki"]').click();
    const dialog = page.locator('[data-testid="confirm-dialog"]');
    await expect(dialog).toBeVisible();
    // 选「中断并立即执行」
    await dialog.getByRole('button', { name: '中断并立即执行' }).click();
    await expect(dialog).not.toBeVisible();

    // D3 语义：中断必须先 cancel 旧 run（DELETE /api/runs/:id），再清空、再自动发送
    await expect.poll(() => cancelRequests).toBe(1);
    // 新建构走 createRun（第 2 次 POST /api/runs）且旧提示词被清掉（user 消息只剩 1 条）
    const msgs = page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible .file-chat-messages');
    await expect.poll(async () => ({ runs: createRunRequests, users: await msgs.locator('.msg.user').count() }))
      .toEqual({ runs: 2, users: 1 });
    // 新建构的 wiki-build 提示词自动出现（原标签被清空后重发）
    await expect(msgs.locator('.msg.user')).toContainText(/wiki-build/, { timeout: 10_000 });
  });
});
