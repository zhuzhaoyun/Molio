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

  test('/chat 冷启动：有持久化活动会话时不闪 landing（历史加载中即为全屏态）', async ({ page }) => {
    await mockChatRun(page);
    // 覆盖 mockChatRun 的即时历史响应：延迟 HISTORY_DELAY_MS，制造一个**比断言超时更宽**的
    // 「历史加载中」窗口。覆盖必须「后注册」（Playwright 后注册的 route 优先）。
    // afterEach 的 unmockAll 会用同一 pattern unroute 掉它。
    const HISTORY_DELAY_MS = 4_000;
    const LOADING_ASSERT_MS = 2_000; // 必须 < HISTORY_DELAY_MS：落在加载窗口内
    await page.route('**/api/conversations/*/messages', async (route) => {
      await new Promise((r) => setTimeout(r, HISTORY_DELAY_MS));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: [
            { id: 'cf-cold-u1', role: 'user', content: '冷启动', timestamp: Date.now() },
            { id: 'cf-cold-a1', role: 'assistant', content: 'Hello, how can I help you?', timestamp: Date.now() + 1, agentId: 'claude' },
          ],
        }),
      });
    });

    // 先在 KB 面板聊一句 → 该会话写入持久化 conversationId（localStorage）。
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill('冷启动');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(
      page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last(),
    ).toBeVisible({ timeout: 10_000 });

    // 冷启动整页重载到 /chat：活动标签已绑定 conversation，历史仍在加载中。
    await page.goto('http://localhost:5173/chat');
    // 关键断言：**在加载窗口内**（< HISTORY_DELAY_MS）全屏 shell 必须已就位。
    // 这里用短超时是有意的 —— 若判据退回「有消息」，此刻仍是 landing（`.home-header` 不存在，
    // 直到 ~HISTORY_DELAY_MS 历史到达才出现），断言会在窗口内超时失败。用默认 5s 会一直重试
    // 到 flash 结束后才通过，等于测不出东西。
    await expect(page.locator('.home-header')).toBeVisible({ timeout: LOADING_ASSERT_MS });
    // 加载窗口内 landing 绝不能出现。
    await expect(page.locator('.home-landing')).toHaveCount(0);
    await expect(page.locator('.home-hero-view')).toHaveCount(0);

    // 历史到达后消息渲染出来，仍是全屏态（未闪回 landing）。
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.home-landing')).toHaveCount(0);
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
