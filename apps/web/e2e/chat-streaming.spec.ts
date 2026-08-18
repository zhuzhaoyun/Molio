import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * E2E tests for SSE event rendering details: thinking blocks, tool use, errors.
 *
 * Each test uses a specific script that exercises different event types.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Chat — streaming details', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('thinking block renders and is collapsible', async ({ page }) => {
    // frameDelay 拉宽流式窗口：默认瞬时 flush 会让 run 在 Playwright 轮询到前就完成，
    // 完成态思考块收进折叠工作块不在 DOM，抓不到「流式自动展开」。
    await mockChatRun(page, { script: SCRIPTS.withThinking, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, 'Analyze this');

    // 流式时：思考块在 WorkBlock 内自动展开，内容可见
    const thinking = page.locator('[data-testid="thinking-block"]');
    await expect(thinking).toBeVisible({ timeout: 10_000 });
    await expect(thinking.locator('.thinking-header')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toContainText('Let me analyze this...');

    // 完成后：思考块收进折叠的工作块详情（默认收起），需先展开工作块再展开思考块
    const summary = page.locator('[data-testid="work-timeline-summary"]');
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await summary.click();
    await expect(thinking.locator('.thinking-content')).toBeHidden();

    // 点击思考块标题 → 展开
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toContainText('Let me analyze this...');

    // 再次点击 → 折叠
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeHidden();
  });

  test('thinking auto-expands during the pre-tool phase, collapses when the first tool arrives', async ({ page }) => {
    // 焦点规则：运行中思考只在前置思考阶段（无工具）自动展开；
    // 第一个工具到达 → 思考折叠让位给操作日志，避免思考+工具+叙事三者同时铺开
    const script = [
      { type: 'status', label: 'running' },
      { type: 'thinking_start' },
      { type: 'thinking_delta', delta: 'Let me check the files...' },
      // 插入叙事帧拉宽「纯思考、无工具」窗口
      { type: 'text_delta', delta: '我先查一下相关文件。' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x.ts' } },
      { type: 'tool_result', toolUseId: 't1', content: 'contents', isError: false },
      { type: 'text_delta', delta: '这是最终答案。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.005 },
    ];
    await mockChatRun(page, { script, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, '整理一下');

    // 纯思考阶段（无工具）：思考自动展开，内容可见
    const thinkContent = page.locator('[data-testid="thinking-block"] .thinking-content');
    await expect(thinkContent).toBeVisible({ timeout: 10_000 });
    await expect(thinkContent).toContainText('Let me check the files...');

    // 第一个工具到达：思考折叠（.thinking-content 移出 DOM），操作日志成为焦点
    await expect(async () => {
      const toolVisible = await page.locator('[data-testid="tool-line"]').isVisible();
      const thinkCount = await thinkContent.count();
      return toolVisible && thinkCount === 0;
    }).toPass({ timeout: 10_000 });
  });

  test('tool use renders inline with name and status', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    // Wait for the response to complete
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });

    // 完成后工具行收进折叠的工作块，展开后可见（单工具不分组，直接 .tool-line）
    await page.locator('[data-testid="work-timeline-summary"]').click();
    const toolLine = page.locator('.tool-line');
    await expect(toolLine).toBeVisible();
    await expect(toolLine.locator('.tool-line-name')).toContainText('Read');

    // Status should show done (✓)
    await expect(toolLine.locator('.tool-line-status')).toContainText('✓');
  });

  test('assistant prose shows only the final answer; narration stays in the work process', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    // Script emits: "Let me check that file." (工具前叙事) → tool_use → " The file looks good." (最终答案)
    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });
    await expect(prose).toContainText('The file looks good.');
    // 叙事不再进正文 —— 工具前的自言自语收在工作块过程流里
    await expect(prose).not.toContainText('Let me check that file.');

    // 展开工作块 → 叙事在过程流里可回看
    await page.locator('[data-testid="work-timeline-summary"]').click();
    const processText = page.locator('[data-testid="work-block-process"]');
    await expect(processText).toContainText('Let me check that file.');
  });

  test('narration streams in the work process; prose shows only the final answer', async ({ page }) => {
    // 叙事→Read→叙事→Grep→答案：两句叙事都发生在 finalTools(=2) 之前
    const script = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: '我先查一下文件。' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '笔记/入门.md' } },
      { type: 'tool_result', toolUseId: 't1', content: '# 入门笔记', isError: false },
      { type: 'text_delta', delta: '再看一下配置。' },
      { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: '配置' } },
      { type: 'tool_result', toolUseId: 't2', content: '匹配 2 处', isError: false },
      { type: 'text_delta', delta: '这是最终整理结果。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 300, output_tokens: 40 }, costUsd: 0.015 },
    ];
    // frameDelay 拉宽流式窗口，验证「流式中叙事在工作块内渐进、正文隐藏」
    await mockChatRun(page, { script, frameDelay: 600 });
    await gotoHome(page);
    await sendMessage(page, '整理一下');

    // 流式中：叙事在工作块内渐进流动，正文尚未出现
    const processText = page.locator('[data-testid="work-block-process"]');
    await expect(processText).toBeVisible({ timeout: 10_000 });
    await expect(processText).toContainText('我先查一下文件。');
    await expect(page.locator('[data-testid="assistant-prose"]')).toHaveCount(0);
    // 执行区有「操作」分区标签（思考/操作分区鲜明）
    await expect(page.locator('[data-testid="work-block-zone-ops-label"]')).toBeVisible({ timeout: 10_000 });

    // 完成后：正文只显示最终答案，两句叙事都留在工作块过程流
    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toContainText('这是最终整理结果。', { timeout: 10_000 });
    await expect(prose).not.toContainText('我先查一下文件。');
    await expect(prose).not.toContainText('再看一下配置。');

    // 展开工作块 → 两句叙事都能回看
    await page.locator('[data-testid="work-timeline-summary"]').click();
    await expect(processText).toContainText('我先查一下文件。');
    await expect(processText).toContainText('再看一下配置。');
  });

  test('streaming shows individual tool steps; latest reveals output; done groups them', async ({ page }) => {
    // 流式 = 逐个工具展示（不分组，Codex 进行时模型）：两次 WebSearch 各占一行带序号，
    // 最新工具结果到达即展开；完成态收进折叠工作块，展开后同名单工具分组归纳。
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: '今日科技新闻' } },
      { type: 'tool_result', toolUseId: 'ws1', content: '英伟达新动向 https://ithome.com/a', isError: false },
      { type: 'tool_use', id: 'ws2', name: 'WebSearch', input: { query: 'AI 大模型新闻' } },
      // 插入文本帧拉宽 ws2 的 running 窗口（done=1 < finalTools=2 → 叙事，仍处流式中）
      { type: 'text_delta', delta: '继续整理中…' },
      { type: 'tool_result', toolUseId: 'ws2', content: 'Kimi 登顶 https://sspai.com/post/8', isError: false },
      { type: 'text_delta', delta: '这是最终整理结果。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 300, output_tokens: 40 }, costUsd: 0.015 },
    ];
    await mockChatRun(page, { script, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, '搜集新闻资讯');

    // 流式中：两个工具逐个展示（不分组），各带步序号 1/2、2/2
    const toolLines = page.locator('[data-testid="tool-line"]');
    await expect(toolLines).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('.tool-line-step')).toHaveText(['1/2', '2/2']);

    // 运行中工具行高亮（当前动作聚焦）
    await expect(page.locator('.tool-line.running')).toBeVisible({ timeout: 10_000 });

    // 最新工具（ws2）结果到达即展开 —— scoped 到 ws2：ws1 的面板流式中也会短暂出现，
    // 通用 [data-testid="tool-output-panel"] 定位会命中错误的面板
    const ws2Panel = page.locator('[data-tool-id="ws2"]').locator('[data-testid="tool-output-panel"]');
    await expect(ws2Panel).toContainText('Kimi 登顶', { timeout: 10_000 });

    // 完成后：分组收进折叠工作块，展开可见「2 次网页搜索」摘要
    const summary = page.locator('[data-testid="work-timeline-summary"]');
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await summary.click();
    await expect(page.locator('.tool-group-label')).toContainText('2');
  });

  test('error event shows in assistant message', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withError });
    await gotoHome(page);
    await sendMessage(page, 'Trigger error');

    // Wait for assistant message to render
    const assistantMsg = page.locator('[data-testid="assistant-message"]');
    await expect(assistantMsg).toBeVisible({ timeout: 10_000 });

    // Error text should appear in the message
    await expect(assistantMsg).toContainText('Something went wrong', { timeout: 5_000 });
  });
});
