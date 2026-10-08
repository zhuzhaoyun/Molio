// apps/web/e2e/chat-fullscreen.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, mockNoAgents, unmockAll } from './helpers/mock-sse';
import { gotoChatSpa } from './helpers/navigation';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area chat
 * @priority P1
 *
 * L2a：`/chat` 是悬浮对话面板的「全屏态」——两者展示**同一个活动会话**（同一份 store / 状态）。
 * Prerequisites: `pnpm dev`.
 */

let vault: TempVault;

test.describe('/chat 全屏态与面板共享活动会话', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-chat-fullscreen');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('/chat 冷启动：本地有活动标签时直接落进该会话', async ({ page }) => {
    await mockChatRun(page, {
      // 冷启动（整页重载）后 controller 从 DB 恢复历史：mock 返回上一轮的消息，
      // 否则会话在 /chat 上没有消息 → 落到 landing（本用例要断言「不是空的 /chat」）。
      persistedMessages: [
        { id: 'cf-u1', role: 'user', content: '冷启动测试', timestamp: Date.now() },
        { id: 'cf-a1', role: 'assistant', content: 'Hello, how can I help you?', timestamp: Date.now() + 1, agentId: 'claude' },
      ],
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill('冷启动测试');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(
      page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last(),
    ).toBeVisible({ timeout: 10_000 });

    // 冷启动：整页重载到 /chat（活动标签从 localStorage 恢复）→ 直接落进该会话
    await page.goto('http://localhost:5173/chat');
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({ timeout: 10_000 });
    // landing（hero）不应该出现 —— 说明展示的是同一个会话，而不是空的 /chat
    await expect(page.locator('.home-hero-view')).toBeHidden();
  });

  test('/chat 冷启动：没有任何标签时显示 landing', async ({ page }) => {
    await mockChatRun(page);
    await page.goto('http://localhost:5173/knowledge');
    await page.evaluate(() => {
      localStorage.removeItem('molio.kb.chatSessions');
      localStorage.removeItem('molio.kb.chatActiveSessionId');
    });
    await page.goto('http://localhost:5173/chat');
    await expect(page.locator('[data-testid="hero-tagline"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="composer-input"]')).toBeVisible();
  });

  test('面板态与全屏态之间切换不丢草稿', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panelInput = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await panelInput.fill('半句话——还没发');

    // SPA 导航到 /chat（草稿缓存在 ChatComposer 的 module 级 Map，两态 composerKey 一致才找得回）
    await gotoChatSpa(page);
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="composer-input"]')).toHaveValue('半句话——还没发');
  });

  test('删除选择态不残留到另一个视图', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill('选择态测试');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(
      page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last(),
    ).toBeVisible({ timeout: 10_000 });

    // 进入勾选删除态（⋯ → 删除），此时顶部出现确认条
    const last = page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last();
    await last.hover();
    await last.locator('[data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="overflow-item-delete"]').last().click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeVisible();

    // 切到 /chat：确认条不得跟着冒出来（messageSelectionStore 是全局单例）
    await gotoChatSpa(page);
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeHidden();
  });

  test('/chat 上无可用运行时显示 NoRuntimeCard', async ({ page }) => {
    await mockNoAgents(page);
    await page.goto('http://localhost:5173/chat');
    await expect(page.locator('[data-testid="no-runtime-card"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="composer-input"]')).toBeHidden();
  });
});
