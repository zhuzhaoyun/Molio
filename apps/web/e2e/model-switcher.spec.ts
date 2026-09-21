import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, mockRewindResend, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * E2E for the composer runtime/model pill — 承接原顶栏 agent chip 的职责：
 *
 *  - 顶栏不再显示 runtime（信息冗余：每条回复 meta 行已显示真实模型 ID）；
 *  - composer-row 的 pill 常驻显示「runtime · 模型」，点击可切模型 / 切 runtime；
 *  - 选择对**下一条消息**即时生效（POST /api/runs 带 model）；
 *  - 模型按 runtime 记入 localStorage，刷新后恢复（用户偏好不得静默回退）。
 *
 * Prerequisites: `pnpm dev` running（daemon + web）。
 */

const MODELS = [
  { id: 'default', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet (alias)' },
  { id: 'opus', label: 'Opus (alias)' },
];

test.describe('Chat — runtime/model pill', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    // pill 选择持久化在 localStorage —— 清掉避免串到下一个用例
    await page.evaluate(() => {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith('molio.chatModel.'))
          .forEach((k) => localStorage.removeItem(k));
      } catch { /* ignore */ }
    }).catch(() => {});
  });

  test('顶栏不再显示 runtime，改由 composer pill 承载', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);
    await sendMessage(page, 'Test message');
    await expect(page.locator('.chat-active')).toBeVisible({ timeout: 10_000 });

    // 回归保护：原顶栏 chip 已移除（避免与每条回复的 meta 行模型信息重复）
    await expect(page.locator('.home-active-agent')).toHaveCount(0);
    // 新家：composer pill 可见且显示 runtime 名
    await expect(page.getByTestId('composer-model-pill')).toBeVisible();
  });

  test('未选模型时 pill 只显示 runtime 名', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    const pill = page.getByTestId('composer-model-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Claude');
  });

  test('菜单含「模型」分组（剔除与「跟随默认」重复的原生 default 项）', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    await page.getByTestId('composer-model-pill').click();
    const menu = page.getByTestId('composer-model-menu');
    await expect(menu).toBeVisible();

    const options = menu.getByTestId('composer-model-option');
    await expect(options).toHaveCount(3); // 跟随默认 + sonnet + opus（default 被剔除）
    await expect(options.nth(1)).toHaveText('Sonnet (alias)');
  });

  test('选模型 → pill 更新为「runtime · 模型」', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-model-option').filter({ hasText: 'Sonnet (alias)' }).click();

    await expect(page.getByTestId('composer-model-pill')).toHaveText('Claude · Sonnet (alias)');
    // 选完自动收起
    await expect(page.getByTestId('composer-model-menu')).toHaveCount(0);
  });

  test('选中的模型随下一条消息发给 daemon（POST /api/runs）', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-model-option').filter({ hasText: 'Opus (alias)' }).click();

    const runRequest = page.waitForRequest(
      (req) => req.url().includes('/api/runs') && req.method() === 'POST',
    );
    await sendMessage(page, '用 opus 回答');

    const body = JSON.parse((await runRequest).postData() ?? '{}');
    expect(body.model).toBe('opus');
  });

  test('未选模型时不带 model 字段（跟随 CLI 默认）', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    const runRequest = page.waitForRequest(
      (req) => req.url().includes('/api/runs') && req.method() === 'POST',
    );
    await sendMessage(page, '默认模型回答');

    const body = JSON.parse((await runRequest).postData() ?? '{}');
    expect(body.model).toBeUndefined();
  });

  test('重新生成也带当前选中的模型（rewind-resend）', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS, runId: 'run-1', conversationId: 'conv-1' });
    await mockRewindResend(page, 'run-2', 'conv-1');

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-model-option').filter({ hasText: 'Sonnet (alias)' }).click();

    const rewindRequest = page.waitForRequest(
      (req) => req.url().includes('/rewind-resend') && req.method() === 'POST',
    );
    await page.locator('[data-testid="assistant-message"]').last().hover();
    await page.locator('[data-testid="msg-regenerate-btn"]').click();

    const body = JSON.parse((await rewindRequest).postData() ?? '{}');
    expect(body.model).toBe('sonnet');
  });

  test('刷新后记住该 runtime 的模型选择', async ({ page }) => {
    await mockChatRun(page, { agentModels: MODELS });
    await gotoHome(page);

    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-model-option').filter({ hasText: 'Sonnet (alias)' }).click();
    await expect(page.getByTestId('composer-model-pill')).toHaveText('Claude · Sonnet (alias)');

    await page.reload();

    // 用户显式选择必须恢复，不得静默回到默认
    await expect(page.getByTestId('composer-model-pill')).toHaveText('Claude · Sonnet (alias)');
  });

  test('切 runtime → 模型回到该 runtime 的常用值（不串味）', async ({ page }) => {
    await mockChatRun(page, {
      agentModels: MODELS,
      extraAgents: [{ id: 'codex', name: 'Codex' }],
    });
    await gotoHome(page);

    // 先给 claude 选一个模型
    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-model-option').filter({ hasText: 'Sonnet (alias)' }).click();
    await expect(page.getByTestId('composer-model-pill')).toHaveText('Claude · Sonnet (alias)');

    // 切到 Codex —— 不应携带 claude 的模型
    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-runtime-option').filter({ hasText: 'Codex' }).click();
    await expect(page.getByTestId('composer-model-pill')).toHaveText('Codex');

    // 切回 claude —— 恢复它自己的常用模型
    await page.getByTestId('composer-model-pill').click();
    await page.getByTestId('composer-runtime-option').filter({ hasText: 'Claude' }).click();
    await expect(page.getByTestId('composer-model-pill')).toHaveText('Claude · Sonnet (alias)');
  });

  test('「跟随默认」副行显示 runtime 当前默认模型（CC Switch 场景）', async ({ page }) => {
    await mockChatRun(page, {
      agentModels: [
        { id: 'opus', label: 'glm-5.3-flash', detail: 'Opus 映射 · glm-5.3-flash[1M]' },
      ],
      agentDefaultModel: { id: 'default', label: 'glm-5.3-flash[1M]' },
    });
    await gotoHome(page);

    await page.getByTestId('composer-model-pill').click();
    const menu = page.getByTestId('composer-model-menu');
    const defaultRow = menu.getByTestId('composer-model-option').first();
    await expect(defaultRow).toContainText('跟随默认');
    await expect(defaultRow).toContainText('当前默认 glm-5.3-flash[1M]');
    // 映射行：主行 = 解析后的真实模型，副行 = 角色说明
    const mapped = menu.getByTestId('composer-model-option').filter({ hasText: 'Opus 映射' });
    await expect(mapped).toContainText('glm-5.3-flash');
  });

  test('运行时组常驻：未安装 runtime 灰态显示，点击跳设置', async ({ page }) => {
    await mockChatRun(page, {
      extraAgents: [{ id: 'codex', name: 'Codex', available: false }],
    });
    await gotoHome(page);

    // 单可用 runtime 也显示「运行时」组
    await page.getByTestId('composer-model-pill').click();
    const unavailable = page.getByTestId('composer-runtime-option-unavailable');
    await expect(unavailable).toContainText('Codex');
    await expect(unavailable).toContainText('未安装');

    await unavailable.click();
    await page.waitForURL(/\/settings\?tab=runtimes/);
  });

  test('运行中 pill 保持可见（为排队消息挑模型）', async ({ page }) => {
    // 脚本刻意不含 turn_end —— run 始终保持「运行中」，断言窗口稳定
    await mockChatRun(page, {
      agentModels: MODELS,
      frameDelay: 300,
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: '思考中…' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '长时间回答');

    await expect(page.getByTestId('composer-stop')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('composer-model-pill')).toBeVisible();
    // 运行中附件区隐藏（既有行为不变）
    await expect(page.getByTestId('composer-upload-btn')).toHaveCount(0);
  });
});
