import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, type MockRunOptions } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * 流式回答的贴底跟随（stick-to-bottom）：
 * 1. 用户贴底时，流式内容长高必须实时跟滚（含工具卡/思考块引起的长高）；
 * 2. 用户上翻阅读即脱离跟随，不被拽回底部，「回到底部」浮标出现；
 * 3. 点击浮标回到最新消息，浮标消失。
 *
 * 用 mock SSE 的 frameDelay 真流式 + 大段 delta 造「内容长得比滚动快」的场景：
 * 老实现（smooth scrollIntoView 被高频更新打断）距底持续拉大，本 spec 全部用例红；
 * 新实现（贴底判定 + 瞬时跟滚）任何一帧都贴底，绿。
 */

/** 每条 delta 约 2000+ 汉字（渲染高度 ≫ 一屏），保证单条 chunk 的长高远超滚动动画推进。 */
function longStreamScript(chunks: number): MockRunOptions['script'] {
  return [
    { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
    ...Array.from({ length: chunks }, (_, i) => ({
      type: 'text_delta',
      delta: `第 ${i + 1} 段。` + '这是一段很长的回答内容，用来把消息区撑到远超一屏高度。'.repeat(110) + '\n\n',
    })),
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 100, output_tokens: 90_000 }, costUsd: 0.5 },
  ];
}

const STREAM_OPTS: MockRunOptions = {
  script: longStreamScript(28),
  frameDelay: 300, // 28 × 300ms ≈ 8.4s 流式时长，给断言留足「流式仍在进行」的窗口
};

/** 等待消息区内容溢出超过 limit px（流式已在把内容撑高）。 */
async function waitForOverflow(page: import('@playwright/test').Page, limit: number) {
  await page.waitForFunction(
    (lim) => {
      const el = document.querySelector('[data-testid="chat-log"]');
      return !!el && el.scrollHeight - el.clientHeight > lim;
    },
    limit,
    { timeout: 10_000 },
  );
}

test.describe('Chat — streaming autoscroll', () => {
  test.beforeEach(async ({ page }) => {
    await mockChatRun(page, STREAM_OPTS);
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('贴底时流式内容持续跟滚，不被甩在后面', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, '给我一份很长的回答');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    // 流式仍在进行、内容已溢出一屏多时，视图必须贴在距底 120px 内。
    // 老代码 smooth 滚动被每 300ms 一次的更新反复打断，距底越拉越大，
    // 只有流结束（≈10s 后）才追上 —— 6s 超时内到不了 → 红。
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-log"]');
        if (!el) return false;
        if (el.scrollHeight - el.clientHeight < 1200) return false; // 等内容够高
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
      },
      undefined,
      { timeout: 6_000 },
    );
  });

  test('上翻阅读脱离跟随，不被拽回底部，浮标出现', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, '给我一份很长的回答');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    await waitForOverflow(page, 1500);
    // 程序化滚回顶部（触发 scroll 事件 → 贴底判定解除）
    await page.locator('[data-testid="chat-log"]').evaluate((el) => {
      el.scrollTop = 0;
    });

    // 之后内容继续长高（≥3500px 溢出），视图必须仍停在顶部
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-log"]');
        if (!el) return false;
        return el.scrollHeight - el.clientHeight > 3500 && el.scrollTop < 150;
      },
      undefined,
      { timeout: 8_000 },
    );

    // 流式进行中且已脱离贴底 → 「回到底部」浮标可见
    await expect(page.locator('[data-testid="chat-jump-bottom"]')).toBeVisible();
  });

  test('点击浮标回到最新消息，浮标消失', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, '给我一份很长的回答');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    await waitForOverflow(page, 1500);
    await page.locator('[data-testid="chat-log"]').evaluate((el) => {
      el.scrollTop = 0;
    });

    const jumpBtn = page.locator('[data-testid="chat-jump-bottom"]');
    await expect(jumpBtn).toBeVisible({ timeout: 8_000 });
    await jumpBtn.click();

    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="chat-log"]');
        if (!el) return false;
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
      },
      undefined,
      { timeout: 5_000 },
    );
    await expect(jumpBtn).toBeHidden();
  });
});
