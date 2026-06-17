/**
 * Mock SSE helper — intercepts daemon API endpoints to return scripted SSE event streams.
 * Eliminates the need for a real AI agent during E2E testing.
 */
import type { Page } from '@playwright/test';

// ── SSE frame formatting ────────────────────────────────────────────────

function sseFrame(seq: number, runId: string, event: object): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, runId, event })}\n\n`;
}

// ── Pre-built event scripts ────────────────────────────────────────────

export const SCRIPTS = {
  /** Minimal text reply — status → 2 text deltas → turn_end → usage */
  simpleTextReply: [
    { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
    { type: 'text_delta', delta: 'Hello, ' },
    { type: 'text_delta', delta: 'how can I help you?' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.005 },
  ],

  /** Reply with thinking block */
  withThinking: [
    { type: 'status', label: 'running' },
    { type: 'thinking_start' },
    { type: 'thinking_delta', delta: 'Let me analyze this...' },
    { type: 'text_delta', delta: 'Based on my analysis, ' },
    { type: 'text_delta', delta: 'here is the answer.' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 200, output_tokens: 30 }, costUsd: 0.01 },
  ],

  /** Reply with a single tool use (Read) */
  withToolUse: [
    { type: 'status', label: 'running' },
    { type: 'text_delta', delta: 'Let me check that file.' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.ts' } },
    { type: 'tool_result', toolUseId: 'tool-1', content: 'file contents here', isError: false },
    { type: 'text_delta', delta: ' The file looks good.' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 300, output_tokens: 40 }, costUsd: 0.015 },
  ],

  /** Reply ending with an error event */
  withError: [
    { type: 'status', label: 'running' },
    { type: 'text_delta', delta: 'Starting...' },
    { type: 'error', message: 'Something went wrong' },
    { type: 'turn_end', stopReason: 'error' },
  ],
} as const;

// ── Types ──────────────────────────────────────────────────────────────

export interface MockRunOptions {
  /** Run ID used in URLs (default: 'test-run-1') */
  runId?: string;
  /** Conversation ID returned in create-run response (default: 'test-conv-1') */
  conversationId?: string;
  /** Ordered list of AgentEvent objects to emit (default: SCRIPTS.simpleTextReply) */
  script?: readonly object[];
  /** Whether to also mock the multi-turn messages endpoint (default: true) */
  multiTurn?: boolean;
}

// ── Main mock function ─────────────────────────────────────────────────

/**
 * Intercept POST /api/runs, GET /api/runs/:id/events (SSE), and related endpoints.
 * Returns scripted SSE events so the frontend renders a complete chat turn
 * without spawning a real AI agent.
 */
export async function mockChatRun(page: Page, opts: MockRunOptions = {}) {
  const runId = opts.runId ?? 'test-run-1';
  const convId = opts.conversationId ?? 'test-conv-1';
  const script = opts.script ?? SCRIPTS.simpleTextReply;

  // 1) POST /api/runs → return { runId, conversationId }
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ runId, conversationId: convId }),
      });
    } else {
      await route.continue();
    }
  });

  // 2) GET /api/runs/:id/events → SSE stream with scripted events
  await page.route(`**/api/runs/${runId}/events**`, async (route) => {
    const frames = script.map((evt, i) => sseFrame(i + 1, runId, evt)).join('');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: {
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
      body: frames,
    });
  });

  // 3) POST /api/runs/:id/messages → multi-turn follow-up
  if (opts.multiTurn !== false) {
    await page.route(`**/api/runs/${runId}/messages`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
  }

  // 4) POST /api/runs/:id/tool-result → interactive tool answer
  await page.route(`**/api/runs/${runId}/tool-result`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  // 5) GET /api/agents → return a fake available agent so the composer is enabled
  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agents: [
          {
            id: 'claude',
            name: 'Claude',
            available: true,
            binary: '/usr/bin/claude',
            source: 'path',
            version: '1.0.0',
            models: [],
            installUrl: 'https://claude.ai',
          },
        ],
      }),
    });
  });

  // 6) GET /api/config → return defaultAgentId so the agent is auto-selected
  await page.route('**/api/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        defaultAgentId: 'claude',
        locale: 'zh',
      }),
    });
  });
}

// ── Cleanup ────────────────────────────────────────────────────────────

/**
 * Remove all route intercepts installed by mockChatRun.
 * Call in afterEach() to prevent state leakage between tests.
 */
export async function unmockAll(page: Page) {
  await page.unroute('**/api/runs');
  await page.unroute('**/api/runs/*/events**');
  await page.unroute('**/api/runs/*/messages');
  await page.unroute('**/api/runs/*/tool-result');
  await page.unroute('**/api/agents');
  await page.unroute('**/api/config');
}
