import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Hermes [acp] extra auto-repair UX:
 *   - `repairing` AgentEvent renders as a transient spinner status line
 *   - `error` event whose message contains a fenced code block renders the
 *     block as a copyable <CodeBlock> (so users can copy the manual pip
 *     command when auto-repair fails)
 */

test.describe('Chat — Hermes repair UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (t: string) => { (window as any).__copied = t; } },
        configurable: true,
      });
    });
  });

  test('repairing event renders as spinner status, clears on first text_delta', async ({ page }) => {
    const script = [
      { type: 'status', label: 'running' },
      { type: 'repairing', message: '检查 Hermes 安装完整性...' },
      { type: 'repairing', message: '修复 Hermes 安装：安装 agent-client-protocol...' },
      { type: 'repairing', message: '验证 Hermes 安装...' },
      { type: 'text_delta', delta: 'Hermes 已就绪，这是回复。' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    // While the repair phase is in progress, the spinner shows the latest
    // progress message.
    const status = page.locator('[data-testid="repairing-status"]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    await expect(status).toContainText('验证 Hermes 安装');

    // After text_delta arrives, the repair status is cleared — it's a
    // transient phase, not part of the saved message.
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('Hermes 已就绪', { timeout: 5_000 });
    await expect(status).toHaveCount(0);
  });

  test('error with fenced code block renders as copyable CodeBlock', async ({ page }) => {
    // Mirrors the real ensureAcpExtra failure message: copyable manual-fix
    // command in a ``` block, followed by a stderr ``` block.
    const errorMessage = [
      'Hermes 自动修复失败（pip install 出错）。请手动运行以下命令修复（hermes-agent venv）：',
      '',
      '```',
      '& "C:\\Users\\test\\venv\\Scripts\\python.exe" -m pip install agent-client-protocol==0.9.0',
      '```',
      '',
      '最后 stderr：',
      '```',
      'ERROR: Could not find a version that satisfies the requirement',
      '```',
    ].join('\n');

    const script = [
      { type: 'status', label: 'running' },
      { type: 'repairing', message: '修复 Hermes 安装：安装 agent-client-protocol...' },
      { type: 'error', message: errorMessage },
      { type: 'turn_end', stopReason: 'error' },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    // Two code blocks should render — the copyable command + the stderr tail.
    const blocks = page.locator('[data-testid="codeblock"]');
    await expect(blocks).toHaveCount(2, { timeout: 5_000 });

    // First block contains the pip command; copy button works.
    const firstCopy = blocks.nth(0).locator('[data-testid="codeblock-copy-btn"]');
    await firstCopy.click();
    const copied = await page.evaluate(() => (window as any).__copied as string);
    expect(copied).toContain('pip install agent-client-protocol==0.9.0');
    expect(copied).not.toContain('```');
  });

  // ── Phase 2 robustness: repairing-state lifecycle (W1/W2/W4/W5) ──

  test('repairing → error: spinner clears and error banner shows (W1)', async ({ page }) => {
    // Previously: error event didn't clear repairing → spinner spun forever
    // alongside the error text. Now: clearRepairing runs on error, and the
    // error lands in a separate banner (not concatenated into content).
    const script = [
      { type: 'status', label: 'running' },
      { type: 'repairing', message: '修复中...' },
      { type: 'error', message: 'ACP timeout: agent hung' },
      { type: 'turn_end', stopReason: 'error' },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    // Spinner visible during repair phase.
    const status = page.locator('[data-testid="repairing-status"]');
    await expect(status).toBeVisible({ timeout: 5_000 });

    // After error arrives, spinner must clear — no permanent spinner.
    await expect(status).toHaveCount(0, { timeout: 5_000 });

    // Error shows in the separate banner, not polluting content.
    const errBanner = page.locator('[data-testid="assistant-error"]');
    await expect(errBanner).toBeVisible();
    await expect(errBanner).toContainText('ACP timeout');
  });

  test('repairing → turn_end (no text): spinner clears (W2)', async ({ page }) => {
    // Previously: turn_end didn't clear repairing → if the agent went straight
    // from repairing to turn_end without any text, the spinner stayed forever
    // on a "done" message. Now: clearRepairing runs on turn_end.
    const script = [
      { type: 'status', label: 'running' },
      { type: 'repairing', message: '修复中...' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    const status = page.locator('[data-testid="repairing-status"]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    await expect(status).toHaveCount(0, { timeout: 5_000 });
  });

  test('repairing → tool_use: repairing clears during tool execution (W4)', async ({ page }) => {
    // Previously: tool_use/tool_result didn't clear repairing → the spinner
    // stayed visible while the agent ran a tool, which was confusing (user
    // thinks "still repairing" while the tool is actually running). Now:
    // clearRepairing runs on tool_use.
    const script = [
      { type: 'status', label: 'running' },
      { type: 'repairing', message: '修复中...' },
      { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolUseId: 'tc-1', content: 'output', isError: false },
      { type: 'text_delta', delta: '完成' },
      { type: 'turn_end', stopReason: 'end_turn' },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    const status = page.locator('[data-testid="repairing-status"]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    // Once tool_use arrives, repairing must clear — tool execution is not repair.
    await expect(status).toHaveCount(0, { timeout: 5_000 });
  });

  test('error event does not pollute content field (W5)', async ({ page }) => {
    // Previously: error was concatenated into content as "\n\nError: ..." →
    // saved messages carried an "Error:" prefix forever. Now: error is a
    // separate field, content stays clean, and the UI shows the error in a
    // distinct banner above the prose.
    const script = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: '正常回复内容' },
      { type: 'error', message: 'something broke' },
      { type: 'turn_end', stopReason: 'error' },
    ];
    await mockChatRun(page, { script, frameDelay: 150 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    // Content keeps the pre-error text, no "Error:" prefix.
    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toContainText('正常回复内容', { timeout: 5_000 });
    await expect(prose).not.toContainText('Error:');

    // Error shows in the separate banner.
    await expect(page.locator('[data-testid="assistant-error"]')).toContainText('something broke');
  });

  test.afterEach(async ({ page }) => { await unmockAll(page); });
});
