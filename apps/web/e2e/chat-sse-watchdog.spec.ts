import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import http from 'node:http';

/**
 * @area chat
 * @priority P0
 *
 * SSE watchdog reconnect (W3.5): the 11.5-min abort bug leaves EventSource at
 * readyState=OPEN but silent — onerror/onDone never fire. The watchdog (45s,
 * shortened via __MOLIO_TEST_WATCHDOG_MS__ here) detects "no frame for N ms"
 * and reconnects to the SAME run with ?after=<lastSeq> so daemon replays missed
 * events. This test verifies the recovery path end-to-end: a run whose first
 * SSE connection goes silent mid-turn must resume rendering once the watchdog
 * reconnects — without re-POSTing /api/runs (no createRun, no session loss).
 */
function sseFrame(seq: number, runId: string, event: object): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, runId, event })}\n\n`;
}

test.describe('Chat — SSE watchdog reconnect', () => {
  test('watchdog reconnects to same run with ?after=, recovering missed events (no createRun)', async ({ page }) => {
    // Shorten watchdog 45s → 1s so the test doesn't wait.
    await page.addInitScript(() => {
      (window as any).__MOLIO_TEST_WATCHDOG_MS__ = 1000;
    });

    const runId = 'watchdog-run-1';
    const convId = 'watchdog-conv-1';
    const eventsRequests: string[] = [];
    let createRunCount = 0;

    // Streaming SSE mock:
    //  - 1st request (no ?after): send status + text_delta('Hello') then go SILENT
    //    (no ping, no end) — simulates the dead-but-OPEN connection that trips
    //    onerror/onDone's blind spot.
    //  - 2nd request (?after=2): replay the missed tail — text_delta(', world')
    //    + turn_end + usage — simulating daemon replaying buffered events after
    //    the watchdog re-subscribes to the same run.
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      eventsRequests.push(url.pathname + url.search);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      const after = Number(url.searchParams.get('after') || 0);
      if (after === 0) {
        res.write(sseFrame(1, runId, { type: 'status', label: 'running' }));
        setTimeout(() => {
          res.write(sseFrame(2, runId, { type: 'text_delta', delta: 'Hello' }));
          // then SILENT — do NOT end, do NOT send ping. Watchdog must fire after 1s.
        }, 50);
      } else {
        // reconnect with ?after=2: replay the missed tail
        res.write(sseFrame(3, runId, { type: 'text_delta', delta: ', world' }));
        setTimeout(() => {
          res.write(sseFrame(4, runId, { type: 'turn_end', stopReason: 'end_turn' }));
          res.write(sseFrame(5, runId, { type: 'usage', usage: {} }));
          res.end();
        }, 50);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    try {
      // POST /api/runs → runId (record count to assert NO createRun on reconnect)
      await page.route('**/api/runs', async (route) => {
        if (route.request().method() === 'POST') {
          createRunCount += 1;
          await route.fulfill({
            status: 201, contentType: 'application/json',
            body: JSON.stringify({ runId, conversationId: convId }),
          });
        } else { await route.continue(); }
      });
      // GET /api/runs/:id/events → forward to the streaming mock
      await page.route(`**/api/runs/${runId}/events**`, async (route) => {
        const url = new URL(route.request().url());
        await route.continue({ url: `http://127.0.0.1:${port}${url.pathname}${url.search}` });
      });
      // Minimal agents/config so the composer is enabled
      await page.route('**/api/agents', async (route) => {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ agents: [{ id: 'claude', name: 'Claude', available: true, binary: '/x', source: 'path', version: '1', models: [], installUrl: 'https://x', installable: false }] }),
        });
      });
      await page.route('**/api/config', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ defaultAgentId: 'claude', locale: 'zh' }) });
      });

      await gotoHome(page);
      await sendMessage(page, 'hi');

      // turn 1 partial renders ('Hello') before the connection goes silent
      const assistant = page.locator('[data-testid="assistant-message"]');
      await expect(assistant).toContainText('Hello', { timeout: 5_000 });

      // After watchdog (1s silent) → reconnect with ?after=2 → replay tail.
      // The same assistant bubble must show the recovered 'Hello, world'.
      await expect(assistant).toContainText('Hello, world', { timeout: 5_000 });

      // Verify the reconnect actually carried ?after=<lastSeq>
      expect(eventsRequests.some((r) => r.includes('after=2'))).toBeTruthy();

      // And NO createRun happened during recovery (session preserved, not a new run)
      expect(createRunCount).toBe(1);
    } finally {
      // EventSource keep-alive connections would hang server.close() — force them.
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
