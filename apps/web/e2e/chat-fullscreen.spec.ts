// apps/web/e2e/chat-fullscreen.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, mockNoAgents, unmockAll } from './helpers/mock-sse';
import { gotoChatSpa, clickNav } from './helpers/navigation';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area chat
 * @priority P1
 *
 * L2a：`/chat` 是悬浮对话面板的「全屏态」——两者展示**同一个活动会话**（同一份 store / 状态）。
 * L2b：把全屏态**显式化**——`/chat` 页头「最小化」⇄ 面板头部「全屏」两个互逆入口；
 *      位处输入框的卡片不再被塞进「输入栏」的装饰里。
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

  // ── L2b：把「全屏态」显式化（两个互逆入口 + 卡片容器适配）──────────────

  /** 在知识库页开面板、发一句、等回复 —— 让 store 里存在一个带消息的活动会话。 */
  async function seedSession(page: import('@playwright/test').Page, text: string) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]').fill(text);
    await page.locator('[data-testid="composer-send"]').click();
    await expect(
      page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]').last(),
    ).toBeVisible({ timeout: 10_000 });
  }

  /** 冷启动到 /chat 时 controller 要从 DB 恢复历史，否则会话没消息 → 落到 landing。 */
  const persisted = (suffix: string) => ({
    persistedMessages: [
      { id: `l2b-u-${suffix}`, role: 'user', content: '问一句', timestamp: Date.now() },
      { id: `l2b-a-${suffix}`, role: 'assistant', content: '答一句', timestamp: Date.now() + 1, agentId: 'claude' },
    ],
  });

  test('面板头部的「全屏」按钮 → 进入 /chat 全屏态，且面板让位', async ({ page }) => {
    await mockChatRun(page);
    await seedSession(page, '全屏入口');

    await page.locator('[data-testid="kb-chat-fullscreen"]').click();

    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.home-header')).toBeVisible({ timeout: 5_000 });
    // 全屏态由 shell 承担，面板必须让位 —— 同一会话不得同屏渲染两份
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toHaveCount(0);
    // 进来的是同一个会话，而不是空的 /chat
    await expect(page.locator('[data-testid="assistant-message"]').last()).toBeVisible({ timeout: 10_000 });
  });

  // 两条「最小化」用例必须**能区分两个分支**，否则等于没测：
  //   · 回退分支 → 回到来源页
  //   · 默认落点分支 → 恒为 `/knowledge`
  // 所以来源页故意选 `/history`（不是 /knowledge）—— 只有回退分支会落到它。

  test('/chat「最小化」→ 收起为悬浮面板并返回来源页（走回退分支）', async ({ page }) => {
    await mockChatRun(page);
    await seedSession(page, '回退分支');
    // 先收起面板，让后面「从历史页开面板」成为确定性动作（不用 isVisible 软跳过）
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"]')).toHaveClass(/--closed/);

    // 站内导航到历史页 —— react-router 导航，站内确实留了一条可回退的记录
    await clickNav(page, 'history');
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.locator('[data-testid="floating-chat-btn"]')).toBeVisible();
    await page.locator('[data-testid="floating-chat-btn"]').click();
    await page.locator('[data-testid="kb-chat-fullscreen"]').click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.home-header')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="home-minimize-btn"]').click();

    // 只有回退分支会落到 /history；默认落点是 /knowledge —— 故本断言能区分两个分支。
    // 不用 `/history$/`：页面若镜像出查询串（如 ?limit=）会让 `$` 失配而误红。
    await expect(page).toHaveURL(/\/history(\?|$)/);
    await expect(page.locator('[data-testid="kb-chat-panel"]')).not.toHaveClass(/--closed/);
  });

  test('/chat 冷启动（入口 replace 落到 /chat）「最小化」→ 落默认落点 /knowledge', async ({ page }) => {
    await mockChatRun(page, persisted('entry'));
    // 会话**只种进 localStorage**，不走 seedSession：本用例要复刻的是「应用的**首个** entry
    // 就是 /chat —— 站内真的没有上一页」。而任何一次 `page.goto` 都会在浏览器历史里留下
    // 上一页，于是 `navigate(-1)` 会真的退回去，就永远测不出线上那个失败形态
    // （线上是**静默无操作**：Electron 里 URL 原地不动、浏览器里退出应用）。
    // addInitScript 在首个导航的页面脚本之前执行，store 模块初始化时就能读到。
    await page.addInitScript(() => {
      localStorage.setItem('molio.kb.chatSessions', JSON.stringify([
        { id: 'seed-entry', title: '入口 replace', conversationId: 'conv-seed', mode: 'qa', vaultId: null, filePath: null },
      ]));
      localStorage.setItem('molio.kb.chatActiveSessionId', 'seed-entry');
      localStorage.setItem('molio.lastRoute', '/chat');
    });

    // 首个导航：应用从入口 `/` 进来。EntryRedirect 是 <Navigate replace/> ——
    // **原地替换**首个 entry：idx 仍是 0，但 key 被换成生成值。
    // 这正是「用 location.key 判有没有上一页」会翻车的那条路径（桌面端每次启动/新窗口都走它）。
    await page.goto('http://localhost:5173/');
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('.home-header')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="home-minimize-btn"]').click();

    // 旧判据下这里会**静默无操作**（URL 原地停在 /chat）→ 本断言失败，复刻线上形态。
    await expect(page).toHaveURL(/\/knowledge(\?|$)/);
  });

  test('全屏态下卡片占用输入框位置时，容器不再是「输入栏」的样子', async ({ page }) => {
    await mockChatRun(page, persisted('card'));
    await seedSession(page, '卡片容器');
    // 破坏运行时列表 → 冷启动回 /chat：会话恢复，输入框位置换成空状态卡片
    await page.unroute('**/api/agents');
    await mockNoAgents(page);
    await page.goto('http://localhost:5173/chat');
    await expect(page.locator('[data-testid="no-runtime-card"]')).toBeVisible({ timeout: 5_000 });

    // 容器仍带着「输入栏」的装饰（全宽分隔缝 + 白底 + 10px 内边距），卡片像被塞进页脚。
    // 卡片在位时容器让出这套装饰。
    const bar = page.locator('.home-composer-bar');
    await expect(bar).toHaveClass(/home-composer-bar--card/);
    await expect(bar).toHaveCSS('border-top-width', '0px');
    await expect(bar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
});
