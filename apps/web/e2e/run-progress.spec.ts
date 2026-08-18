/**
 * @area chat
 * @priority P0
 *
 * Run progress visibility:
 *   - RunStatusBar 在 tool_use 时出现，完成后消失
 *   - RunStatusBar 各阶段显示正确（thinking / tool / generating）
 *   - ThinkingBlock 流式时自动展开
 *   - ToolCard 流式最新工具结果到达即展开；≥5s 慢工具兜底提前展开；完成后随卡片折叠
 *   - ToolCard 显示耗时
 */

import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, SCRIPTS, unmockAll } from './helpers/mock-sse';

test.describe('Chat — Run progress visibility', () => {
  test.beforeEach(async ({ page }) => {
    await mockChatRun(page, { frameDelay: 120 });
    await gotoHome(page);
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  // ── P0: RunStatusBar 出现和消失 ──

  test('RunStatusBar appears during tool execution and disappears on completion', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 2' } },
      { type: 'tool_result', toolUseId: 't1', content: 'done', isError: false },
      { type: 'text_delta', delta: '完成' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
      { type: 'status', label: 'completed', model: 'claude-sonnet-4-5' },
    ];
    // 重新 mock，覆盖 beforeEach 的默认 script
    await unmockAll(page);
    await mockChatRun(page, { script, frameDelay: 120 });
    await gotoHome(page);
    await sendMessage(page, 'run a command');

    // tool_use 事件后状态条应出现
    const bar = page.locator('[data-testid="run-status-bar"]');
    await expect(bar).toBeVisible({ timeout: 5_000 });
    await expect(bar).toContainText('Bash');

    // 完成后状态条消失
    await expect(bar).toHaveCount(0, { timeout: 10_000 });
  });

  // ── P1: 各阶段显示 ──

  test('RunStatusBar shows thinking phase', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'thinking_delta', delta: '让我分析...' },
      { type: 'thinking_delta', delta: '这个问题涉及...' },
      { type: 'text_delta', delta: '这是回答。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    await mockChatRun(page, { script, frameDelay: 200 });
    await gotoHome(page);
    await sendMessage(page, 'think about this');

    const bar = page.locator('[data-testid="run-status-bar"]');
    await expect(bar).toBeVisible({ timeout: 5_000 });

    // thinking 阶段用紫色圆点
    await expect(bar).toHaveAttribute('data-phase', 'thinking');
  });

  test('RunStatusBar shows generating phase', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    await mockChatRun(page, { script, frameDelay: 200 });
    await gotoHome(page);
    await sendMessage(page, 'say hello');

    const bar = page.locator('[data-testid="run-status-bar"]');
    await expect(bar).toBeVisible({ timeout: 5_000 });

    // 有 text 内容时进入 generating 阶段
    await expect(bar).toHaveAttribute('data-phase', 'generating');
  });

  // ── P1: ThinkingBlock 自动展开 ──

  test('ThinkingBlock auto-expands during streaming', async ({ page }) => {
    await unmockAll(page);
    // frameDelay 拉宽流式窗口（默认瞬时 flush → 完成态思考块收进折叠工作块，抓不到自动展开）
    await mockChatRun(page, { script: SCRIPTS.withThinking, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, 'think please');

    // 思考过程应自动展开，内容可见
    const content = page.locator('[data-testid="thinking-block"] .thinking-content');
    await expect(content).toBeVisible({ timeout: 5_000 });
    await expect(content).toContainText('Let me analyze');
  });

  // ── P1: Tool 智能展开 ──

  test('tool auto-expands after 5 seconds running', async ({ page }) => {
    // 单独测试 tool 行为：用长 frameDelay 模拟慢工具
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 'slow-1', name: 'Bash', input: { command: 'npm install' } },
      // 延迟足够长让前端计时器超过 5s
      { type: 'tool_result', toolUseId: 'slow-1', content: 'packages installed', isError: false },
      { type: 'text_delta', delta: '完成' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    // frameDelay 6000ms → tool_use 后 6s 才到 tool_result：运行中超 5s 先触发兜底展开，
    // 随后结果到达走 open 态（流式最新工具）接力保持展开 —— 面板全程可见
    await mockChatRun(page, { script, frameDelay: 6000 });
    await gotoHome(page);
    await sendMessage(page, 'install');

    // tool_use 出现在第一帧之后
    await expect(page.locator('[data-testid="tool-line"]')).toBeVisible({ timeout: 10_000 });

    // 等待自动展开（5s 阈值 + frameDelay）
    const panel = page.locator('[data-testid="tool-output-panel"]');
    await expect(panel).toBeVisible({ timeout: 12_000 });
    await expect(panel).toContainText('packages installed');
  });

  test('latest tool reveals output while streaming; collapses with the card on completion', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 'live-1', name: 'Read', input: { file_path: '/x.ts' } },
      { type: 'tool_result', toolUseId: 'live-1', content: 'file content', isError: false },
      { type: 'text_delta', delta: 'done' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    // frameDelay 800 → 拉宽流式窗口：tool_result 到达时仍在流式中，最新工具结果即展开
    await mockChatRun(page, { script, frameDelay: 800 });
    await gotoHome(page);
    await sendMessage(page, 'read file');

    // 流式中：最新工具结果到达即展开输出面板（不再是「快速工具保持折叠」）
    const panel = page.locator('[data-testid="tool-output-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText('file content');

    // 完成后：工作块折叠 → 工具行连同输出面板一并收起，面板不在 DOM
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });
    await expect(panel).toHaveCount(0, { timeout: 5_000 });
  });

  // ── P2: Tool 显示耗时 ──

  test('tool line shows elapsed time', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 't1', content: 'file1\nfile2', isError: false },
      { type: 'text_delta', delta: 'ok' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    // frameDelay 1200ms → tool_use 到 tool_result 间隔 ≥1s，elapsed ≥ 1
    await mockChatRun(page, { script, frameDelay: 1200 });
    await gotoHome(page);
    await sendMessage(page, 'ls');

    // 完成后展开工作块，工具行可见
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="work-timeline-summary"]').click();

    // tool 完成后应显示耗时
    const toolLine = page.locator('[data-testid="tool-line"]');
    await expect(toolLine).toBeVisible({ timeout: 5_000 });
    // 耗时格式: ⏱ Ns（数字 + s）
    await expect(toolLine).toContainText(/⏱\s*\d+s/, { timeout: 10_000 });
  });

  // ── P1: 手动展开覆盖自动行为 ──

  test('manual expand overrides auto-expand', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'long-task' } },
      { type: 'tool_result', toolUseId: 't1', content: 'result', isError: false },
      { type: 'text_delta', delta: 'done' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await unmockAll(page);
    // 短 frameDelay → 不会触发自动展开
    await mockChatRun(page, { script, frameDelay: 100 });
    await gotoHome(page);
    await sendMessage(page, 'run');

    // 完成后展开工作块，has-output class 出现时才有点击 handler
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="work-timeline-summary"]').click();
    const toolLine = page.locator('[data-testid="tool-line"].has-output');
    await expect(toolLine).toBeVisible({ timeout: 5_000 });
    await toolLine.click();

    // 应该出现输出面板
    await expect(page.locator('[data-testid="tool-output-panel"]')).toBeVisible({ timeout: 3_000 });

    // 再次点击折叠
    await toolLine.click();
    await expect(page.locator('[data-testid="tool-output-panel"]')).toHaveCount(0, { timeout: 3_000 });
  });
});
