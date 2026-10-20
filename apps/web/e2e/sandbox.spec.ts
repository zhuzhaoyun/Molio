import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * rule-sandbox 交互块：模型输出 ```rule-sandbox 围栏 JSON 后，聊天内渲染成
 * 可拖动的阈值演示。拖动参数越过阈值 → 判定实时翻转。全部判定在前端完成，
 * 不依赖 runtime 工具调用，也不发任何请求。
 */

const VAULT_ID = 'vault-1';

const SANDBOX_JSON = {
  version: 1,
  kind: 'rule-sandbox',
  title: '负载预警',
  template: 'threshold-axis',
  params: [{ id: 'load', label: '服务器负载', min: 0, max: 100, value: 60, unit: '%', step: 5 }],
  fixed: [{ id: 'threshold', label: '警戒线', value: 80 }],
  verdicts: [
    {
      when: { all: [{ param: 'load', op: '>', value: 'threshold' }] },
      tone: 'error',
      title: '负载过高',
      detail: '超过警戒线，应扩容或限流。',
      sources: [{ path: 'notes/运维手册.md', quote: '负载持续高于 80% 需人工介入' }],
    },
  ],
  defaultVerdict: {
    tone: 'ok', title: '负载正常', detail: '低于警戒线，无需处理。',
    sources: [{ path: 'notes/运维手册.md', quote: '负载低于 80% 属正常区间' }],
  },
};

const SANDBOX_MARKDOWN = `拖动滑块看看负载变化会怎样。

\`\`\`rule-sandbox
${JSON.stringify(SANDBOX_JSON, null, 2)}
\`\`\``;

const SECOND_SANDBOX_JSON = {
  ...SANDBOX_JSON,
  title: '温度预警',
  params: [{ id: 'load', label: '服务器温度', min: 0, max: 100, value: 20, unit: '℃', step: 5 }],
  fixed: [{ id: 'threshold', label: '报警线', value: 60 }],
};

function scriptFor(markdown: string) {
  return [
    { type: 'status', label: 'running' },
    { type: 'text_delta', delta: markdown },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 100, output_tokens: 80 }, costUsd: 0.01 },
  ];
}

test.describe('Rule sandbox interaction block', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((vid) => {
      try { localStorage.setItem('molio.activeVaultId', vid); } catch { /* ignore */ }
    }, VAULT_ID);

    await page.route('**/api/knowledge/vaults', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vaults: [{ id: VAULT_ID, name: 'Test Vault', path: '/tmp/vault', createdAt: 0, updatedAt: 0 }],
        }),
      });
    });

    await page.route('**/api/knowledge/active-vault', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ vaultId: VAULT_ID, vault: null }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });

    await page.route('**/api/knowledge/vaults/vault-1/resolve/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: 'notes/运维手册.md' }),
      });
    });
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    await page.unroute('**/api/knowledge/vaults');
    await page.unroute('**/api/knowledge/active-vault');
    await page.unroute('**/api/knowledge/vaults/vault-1/resolve/**');
  });

  test('renders the sandbox card with axis, marker and initial verdict', async ({ page }) => {
    await mockChatRun(page, { script: scriptFor(SANDBOX_MARKDOWN) });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下负载预警');

    await expect(page.locator('[data-testid="sandbox-card"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="sandbox-title"]')).toHaveText('负载预警');
    await expect(page.locator('[data-testid="sandbox-axis"]')).toBeVisible();
    await expect(page.locator('[data-testid="sandbox-marker"][data-marker-id="threshold"]')).toBeVisible();
    await expect(page.locator('[data-testid="sandbox-handle"]')).toHaveAttribute('aria-valuenow', '60');
    await expect(page.locator('[data-testid="sandbox-verdict-title"]')).toHaveText('负载正常');
    await expect(page.locator('[data-testid="sandbox-verdict"]')).toHaveAttribute('data-tone', 'ok');
    await expect(page.locator('[data-testid="sandbox-source"]')).toHaveCount(1);
  });

  test('keyboard arrows flip the verdict across the threshold', async ({ page }) => {
    await mockChatRun(page, { script: scriptFor(SANDBOX_MARKDOWN) });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下负载预警');

    const handle = page.locator('[data-testid="sandbox-handle"]');
    await expect(handle).toBeVisible({ timeout: 10_000 });
    await handle.focus();
    // step=5：60 → 85 跨过警戒线 80
    for (let i = 0; i < 5; i++) await handle.press('ArrowRight');

    await expect(handle).toHaveAttribute('aria-valuenow', '85');
    await expect(page.locator('[data-testid="sandbox-verdict"]')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('[data-testid="sandbox-verdict-title"]')).toHaveText('负载过高');

    for (let i = 0; i < 5; i++) await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', '60');
    await expect(page.locator('[data-testid="sandbox-verdict-title"]')).toHaveText('负载正常');
  });

  test('pointer drag clamps at the right end of the axis', async ({ page }) => {
    await mockChatRun(page, { script: scriptFor(SANDBOX_MARKDOWN) });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下负载预警');

    const handle = page.locator('[data-testid="sandbox-handle"]');
    await expect(handle).toBeVisible({ timeout: 10_000 });
    const axis = page.locator('[data-testid="sandbox-axis"]');
    const axisBox = await axis.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(axisBox).not.toBeNull();
    expect(handleBox).not.toBeNull();
    if (!axisBox || !handleBox) return;

    // 拖到轨道右端之外 50px —— 值必须被 clamp 到 max，不能越界。
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(axisBox.x + axisBox.width + 50, axisBox.y + axisBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(handle).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('[data-testid="sandbox-verdict"]')).toHaveAttribute('data-tone', 'error');
  });

  test('invalid JSON degrades to a code block', async ({ page }) => {
    await mockChatRun(page, {
      script: scriptFor('看这个：\n\n```rule-sandbox\n{ not json\n```'),
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下');

    await expect(page.locator('[data-testid="codeblock"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="codeblock"]')).toContainText('not json');
    await expect(page.locator('[data-testid="sandbox-card"]')).toHaveCount(0);
  });

  test('two sandbox blocks render and drag independently', async ({ page }) => {
    await mockChatRun(page, {
      script: scriptFor(
        `${SANDBOX_MARKDOWN}\n\n再来一个：\n\n\`\`\`rule-sandbox\n${JSON.stringify(SECOND_SANDBOX_JSON, null, 2)}\n\`\`\``,
      ),
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示两个');

    const cards = page.locator('[data-testid="sandbox-card"]');
    await expect(cards).toHaveCount(2, { timeout: 10_000 });
    await expect(cards.nth(0).locator('[data-testid="sandbox-title"]')).toHaveText('负载预警');
    await expect(cards.nth(1).locator('[data-testid="sandbox-title"]')).toHaveText('温度预警');

    const first = cards.nth(0).locator('[data-testid="sandbox-handle"]');
    await first.focus();
    for (let i = 0; i < 5; i++) await first.press('ArrowRight');

    await expect(first).toHaveAttribute('aria-valuenow', '85');
    await expect(cards.nth(1).locator('[data-testid="sandbox-handle"]')).toHaveAttribute('aria-valuenow', '20');
  });

  test('shows a generating placeholder while the fence is still streaming', async ({ page }) => {
    // 流式期间围栏未闭合 → 显示「正在生成演示…」占位，而不是把 JSON 一行行糊出来。
    // 每帧 800ms：未闭合围栏从第一帧持续到最后一帧，窗口约 2.4s。
    const json = JSON.stringify(SANDBOX_JSON);
    const cut = Math.floor(json.length / 2);
    await mockChatRun(page, {
      frameDelay: 800,
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: '我给你演示一下。\n```rule-sandbox\n' + json.slice(0, cut) },
        { type: 'text_delta', delta: json.slice(cut) + '\n```' },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下负载预警');

    await expect(page.locator('[data-testid="sandbox-generating"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="sandbox-card"]')).toHaveCount(0);

    // 流结束、围栏闭合后，占位消失，卡片出现。
    await expect(page.locator('[data-testid="sandbox-generating"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="sandbox-card"]')).toHaveCount(1);
  });

  test('renders the sandbox card even when the fence precedes the last tool call', async ({ page }) => {
    // 回归（quiz 同款）：splitMessageParts 把最后一个工具之前的文本归入过程叙事，
    // WorkBlock 会剥掉闭合围栏 —— 若围栏后还有工具调用，卡片在活动会话里消失，
    // 直到整页刷新才回来。
    await mockChatRun(page, {
      runId: 'run-1',
      conversationId: 'conv-1',
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: SANDBOX_MARKDOWN },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'notes/运维手册.md' } },
        { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
        { type: 'text_delta', delta: '以上就是演示。' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 80 }, costUsd: 0.01 },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下负载预警');

    const cards = page.locator('[data-testid="sandbox-card"]');
    await expect(cards).toHaveCount(1, { timeout: 10_000 });
    await expect(cards.locator('[data-testid="sandbox-title"]')).toHaveText('负载预警');
    await expect(page.locator('[data-testid="sandbox-generating"]')).toHaveCount(0);
  });

  test('shows a notice when some verdicts were discarded as malformed', async ({ page }) => {
    // 回归：解析层会丢弃不合协议的判定（单条坏 → 只废该条），但丢弃信息若不
    // 呈现，用户在那些区间只会看到 defaultVerdict（通常是「正常」），与事实
    // 相反且毫无迹象。
    const malformed = {
      ...SANDBOX_JSON,
      verdicts: [
        SANDBOX_JSON.verdicts[0],
        // 阈值写成字符串数字 —— 协议按严格类型校验，这条会被丢弃。
        {
          when: { all: [{ param: 'load', op: '>', value: '80' }] },
          tone: 'error',
          title: '不该出现的判定',
          detail: 'x',
          sources: [{ path: 'notes/运维手册.md' }],
        },
      ],
    };
    await mockChatRun(page, {
      script: scriptFor(`看这个：\n\n\`\`\`rule-sandbox\n${JSON.stringify(malformed, null, 2)}\n\`\`\``),
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下');

    await expect(page.locator('[data-testid="sandbox-card"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="sandbox-invalid-verdict"]')).toHaveCount(1);
    // 丢弃原因直接展示原始诊断（quiz 同款），里面带被判错的值 "80"。
    await expect(page.locator('[data-testid="sandbox-invalid-verdict"]')).toContainText('80');
  });

  test('shows a friendly message when the fence was never closed', async ({ page }) => {
    // 围栏没闭合且流已结束：不能把半截 JSON 整段糊在聊天里（quiz 有
    // 「题目没有生成完整」提示，sandbox 也应有对应文案）。
    await mockChatRun(page, {
      script: [
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: '演示如下：\n```rule-sandbox\n{"version":1,"kind":"rule-sandbox"' },
        { type: 'turn_end', stopReason: 'end_turn' },
      ],
    });
    await gotoHome(page);
    await sendMessage(page, '给我演示一下');

    await expect(page.locator('[data-testid="sandbox-incomplete"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="sandbox-card"]')).toHaveCount(0);
  });
});
