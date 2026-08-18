import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Source chips spacing regression. The hover-reveal message toolbar is an
 * absolute overlay inside the message, so it must NOT reserve in-flow space:
 * a completed message's last content (source chips here) should sit tight to
 * the message bottom. Previously the in-flow toolbar reserved ~32px of phantom
 * gap under every message — perceived as "来源记录纵向间距过大".
 */

test.describe('Chat — message bottom spacing', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('no phantom gap below source chips', async ({ page }) => {
    // 8 条网页来源 → SourceChips 渲染；WebSearch 工具收进工作块（hasWorkBlock），
    // 完成态稳定信号用 work-timeline-summary（工作块折叠摘要头）。
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 'ws', name: 'WebSearch', input: { query: 'AI 新闻' } },
      { type: 'tool_result', toolUseId: 'ws', content: '参考：https://ithome.com/a/1 https://sspai.com/post/8 https://36kr.com/p/222 https://zhihu.com/question/1 https://infoq.cn/news/abc https://jiqizhixin.com/articles/x https://yuanbao.tencent.com/robot https://cloud.tencent.cn/dev/1', isError: false },
      { type: 'text_delta', delta: '这是最终整理结果，下面这些是本次搜集到的来源。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 300, output_tokens: 40 }, costUsd: 0.015 },
    ];
    await mockChatRun(page, { script });
    await gotoHome(page);
    await sendMessage(page, '搜集新闻');

    // 完成态：工作块折叠摘要头出现
    await expect(page.locator('[data-testid="work-timeline-summary"]')).toBeVisible({ timeout: 15_000 });
    // 来源 chips 渲染完成
    const msg = page.locator('[data-testid="assistant-message"]').first();
    const chips = msg.locator('.source-chips');
    await expect(chips).toBeVisible();

    // chips 是消息最后一块内容（hasWorkBlock 时无 usage-footer），
    // 其底部到消息底部的空白应接近 0（旧行为：~33px 隐藏工具栏占位）。
    const msgBox = await msg.boundingBox();
    const chipsBox = await chips.boundingBox();
    expect(msgBox).toBeTruthy();
    expect(chipsBox).toBeTruthy();
    const gap = msgBox!.y + msgBox!.height - (chipsBox!.y + chipsBox!.height);
    console.log(`gap between source chips bottom and message bottom: ${gap}px`);
    expect(gap).toBeLessThan(20);
  });
});
