import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * ActivityTree — live background subagent/workflow activity. The daemon's
 * transcript watcher emits `activity` SSE events while the parent stream is
 * silent (post turn_end, Workflow still running); the UI must keep showing
 * what's alive and what each worker is doing.
 */

const ACTIVITY_REPLY = [
  { type: 'status', label: 'running' },
  { type: 'text_delta', delta: 'Starting the build...' },
  {
    type: 'tool_use',
    id: 'wf-1',
    name: 'Workflow',
    input: {
      script: "export const meta = {\n  name: 'demo-l1',\n  description: 'demo digest workflow',\n};",
    },
  },
  {
    type: 'activity',
    activity: {
      active: true,
      agents: [
        { id: 'spawn:wf-1', label: 'demo digest workflow', status: 'running', lastAction: 'spawned', updatedAt: 1 },
        { id: 'agent-a1', label: 'R001 digest', status: 'running', lastAction: 'Read transcode.txt', updatedAt: 2, tokens: 100 },
        { id: 'agent-a2', label: 'R002 digest', status: 'done', lastAction: 'completed', updatedAt: 3 },
      ],
    },
  },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001 },
];

test.describe('Chat — activity tree', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('renders background subagent activity from activity events', async ({ page }) => {
    await mockChatRun(page, { script: ACTIVITY_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'build wiki');

    const tree = page.locator('[data-testid="activity-tree"]');
    await expect(tree).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="activity-item"]')).toHaveCount(3);
    await expect(tree).toContainText('后台任务');
    await expect(tree).toContainText('R001 digest');
    await expect(tree).toContainText('Read transcode.txt');
  });

  test('Workflow tool card shows meta description and name badge', async ({ page }) => {
    await mockChatRun(page, { script: ACTIVITY_REPLY });
    await gotoHome(page);
    await sendMessage(page, 'build wiki');

    const wfLine = page.locator('[data-testid="tool-line"]').filter({ hasText: 'Workflow' });
    await expect(wfLine).toBeVisible({ timeout: 10_000 });
    await expect(wfLine).toContainText('demo digest workflow');
    await expect(wfLine.locator('.tool-line-badge')).toHaveText('demo-l1');
  });
});
