/**
 * Mock SSE helper — intercepts daemon API endpoints to return scripted SSE event streams.
 * Eliminates the need for a real AI agent during E2E testing.
 */
import type { Page } from '@playwright/test';
import http from 'node:http';

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

  /** A different reply text so tests can verify regeneration actually re-ran. */
  regenerateReply: [
    { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
    { type: 'text_delta', delta: 'Here is a fresh, different answer.' },
    { type: 'turn_end', stopReason: 'end_turn' },
    { type: 'usage', usage: { input_tokens: 110, output_tokens: 25 }, costUsd: 0.006 },
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
  /** Delay (ms) between SSE frames. When set, frames are streamed via a
   *  ReadableStream so React can render transient states (e.g. the `repairing`
   *  spinner that's cleared by the next event). When unset, all frames are
   *  delivered at once — fine for tests that only check the final state. */
  frameDelay?: number;
  /** 已持久化的会话历史消息（DB 加载 / 重挂载恢复用）。默认 [] —— 避免真实 daemon
   *  对未知 conv 404 → onLoadError 关标签。响应结构对齐 daemon：`{ messages: [...] }`。 */
  persistedMessages?: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>;
  /** Turn scripts streamed over the SAME SSE connection, one per drained queued
   *  message, in drain order. Only supported with `frameDelay` set (needs a live
   *  streaming server). Each element is a full turn script (status running →
   *  text_delta… → turn_end → usage). */
  secondTurnScripts?: Array<readonly object[]>;
}

// ── Main mock function ─────────────────────────────────────────────────

/**
 * Streaming SSE servers started by mockChatRun when frameDelay is set.
 * unmockAll closes them so they don't leak across tests.
 */
const streamingServers: http.Server[] = [];

/**
 * Intercept POST /api/runs, GET /api/runs/:id/events (SSE), and related endpoints.
 * Returns scripted SSE events so the frontend renders a complete chat turn
 * without spawning a real AI agent.
 */
export async function mockChatRun(page: Page, opts: MockRunOptions = {}) {
  const runId = opts.runId ?? 'test-run-1';
  const convId = opts.conversationId ?? 'test-conv-1';
  const script = opts.script ?? SCRIPTS.simpleTextReply;

  // Multi-turn POST signaling for secondTurnScripts: the SSE server streams each
  // second-turn script only after the corresponding queued-message POST arrives
  // (a POST may land BEFORE the primary script finishes — buffer it, don't lose it).
  let pendingPosts: string[] = [];
  const postWaiters: Array<() => void> = [];
  function onMultiTurnPost(text: string) {
    pendingPosts.push(text);
    postWaiters.splice(0).forEach((r) => r());
  }
  async function waitForNthPost(n: number): Promise<string> {
    while (pendingPosts.length <= n) {
      await new Promise<void>((r) => postWaiters.push(r));
    }
    return pendingPosts[n]!;
  }

  // 1) POST /api/runs → return { runId, conversationId }
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ runId, conversationId: convId }),
      });
    } else {
      // GET（listRuns）→ 返回活跃 run（含 conversationId）。KB 会话重挂载/切历史时
      // 用它定位活跃 run 并恢复直播（maybeResume → resumeRun）。对现有测试无影响：
      // 无消息的会话 → resumeRun 空消息守卫拦截；convId 不匹配的历史会话 → 不恢复。
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [{
            id: runId,
            agentId: 'claude',
            status: 'running',
            createdAt: 0,
            lastStopReason: null,
            conversationId: convId,
          }],
        }),
      });
    }
  });

  // 2) GET /api/runs/:id/events → SSE stream with scripted events
  if (opts.frameDelay && opts.frameDelay > 0) {
    // Playwright's route.fulfill buffers the full body and sends it at once —
    // fine for final-state tests but useless for transient states (the
    // `repairing` spinner, tool-use spinner) which are cleared by the next
    // event. For those, start a real HTTP server that streams frames with a
    // delay and forward the SSE request to it via route.continue.
    const connections = new Set<import('node:net').Socket>();
    const streamingServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      // Track the socket so unmockAll can destroy it — server.close() alone
      // waits for keep-alive connections to drain, which hangs forever on an
      // EventSource that auto-reconnects.
      const socket = res.socket;
      if (socket) {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
      }
      (async () => {
        // Monotonic seq across ALL scripts on this one connection — the real
        // daemon numbers a run's events continuously, so a second turn starts
        // at seq N+1, not 1.
        let seq = 0;
        const streamScript = async (turn: readonly object[]) => {
          for (const evt of turn) {
            seq += 1;
            res.write(sseFrame(seq, runId, evt));
            await new Promise((r) => setTimeout(r, opts.frameDelay));
          }
        };
        await streamScript(script);
        // Stream the drained turns over the SAME connection — one per queued
        // message, in drain order, each gated on its POST arriving. If no POST
        // ever arrives the connection stays open and the test times out.
        for (let t = 0; t < (opts.secondTurnScripts?.length ?? 0); t++) {
          await waitForNthPost(t);
          await streamScript(opts.secondTurnScripts![t]!);
        }
        res.end();
      })();
    });
    await new Promise<void>((resolve) => streamingServer.listen(0, '127.0.0.1', resolve));
    const addr = streamingServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    streamingServers.push(streamingServer);
    (streamingServer as any).__connections = connections;

    await page.route(`**/api/runs/${runId}/events**`, async (route) => {
      const url = new URL(route.request().url());
      const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      await route.continue({ url: target });
    });
  } else {
    // `route.fulfill` closes the response, so EventSource auto-reconnects. For a
    // NON-terminal script (no status completed/failed) that reconnect re-serves
    // the script — which the multi-turn tests rely on to simulate the daemon
    // streaming the next turn over the same connection. But for a TERMINAL script
    // the run is over: replaying would re-deliver already-seen events and mask a
    // bug where the FIRST delivery dropped one (e.g. codex `usage` without
    // `turn_end` — the round-1 streaming guard dropped the stamp, then a replay
    // re-stamped it against the now-non-streaming bubble, hiding the regression).
    // Chromium's auto-reconnect carries no `?after=`/Last-Event-ID, so honoring
    // `after` alone is not enough — terminal scripts serve exactly once.
    const isTerminal = script.some((evt) => {
      const e = evt as { type?: string; label?: string };
      return e.type === 'status' && (e.label === 'completed' || e.label === 'failed');
    });
    let served = false;
    await page.route(`**/api/runs/${runId}/events**`, async (route) => {
      if (served && isTerminal) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
          body: '',
        });
        return;
      }
      served = true;
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
  }

  // 3) POST /api/runs/:id/messages → multi-turn follow-up
  if (opts.multiTurn !== false) {
    await page.route(`**/api/runs/${runId}/messages`, async (route) => {
      // With secondTurnScripts, signal the SSE server that this queued message
      // was dispatched, so it can stream the corresponding turn over the same
      // connection. Body is `{ message: "<text>" }` (matches api.sendMessage).
      if (opts.secondTurnScripts && route.request().method() === 'POST') {
        const body = JSON.parse(route.request().postData() || '{}');
        onMultiTurnPost(typeof body.message === 'string' ? body.message : '');
      }
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

  // 7) GET /api/conversations/:convId/messages → persisted session history
  //    （重挂载恢复的 DB 加载源；默认空历史避免真实 daemon 对未知 conv 404 → onLoadError）
  await page.route(`**/api/conversations/${convId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: opts.persistedMessages ?? [] }),
    });
  });
}

/**
 * Mock POST /api/conversations/:id/rewind-resend to return a new runId, and
 * mock that new run's SSE stream with `script`.
 */
export async function mockRewindResend(
  page: Page,
  newRunId: string,
  conversationId: string,
  script: readonly object[] = SCRIPTS.regenerateReply,
) {
  await page.route('**/api/conversations/*/rewind-resend', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runId: newRunId, conversationId }),
    });
  });
  await page.route(`**/api/runs/${newRunId}/events**`, async (route) => {
    const frames = script.map((evt, i) => sseFrame(i + 1, newRunId, evt)).join('');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      body: frames,
    });
  });
}

// ── Cleanup ────────────────────────────────────────────────────────────

/**
 * Mock POST /api/conversations/:id/delete-messages — records the ids and
 * returns a deleted count.
 */
export async function mockDeleteMessages(page: Page) {
  await page.route('**/api/conversations/*/delete-messages', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deleted: ids.length }),
    });
  });
}

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
  await page.unroute('**/api/conversations/*/messages');
  await page.unroute('**/api/conversations/*/rewind-resend');
  await page.unroute('**/api/conversations/*/delete-messages');
  // Close any streaming SSE servers started with frameDelay so they don't
  // leak sockets across tests. Destroy active connections first — EventSource
  // keeps keep-alive connections open, and server.close() alone would hang
  // waiting for them to drain.
  for (const s of streamingServers) {
    const conns = (s as any).__connections as Set<import('node:net').Socket> | undefined;
    if (conns) for (const c of conns) c.destroy();
  }
  await Promise.all(streamingServers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  streamingServers.length = 0;
}
