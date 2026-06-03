import { Hono } from 'hono';
import type { RunManager } from '../core/RunManager.js';

export function agentsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  // GET / — list detected agents (re-scans each call)
  app.get('/', (c) => {
    const agents = runManager.detectAgents();
    return c.json({ agents });
  });

  // POST /:agentId/test — test agent connectivity with a short run
  app.post('/:agentId/test', async (c) => {
    const agentId = c.req.param('agentId');
    const timeoutMs = 30_000; // 30s max

    const agents = runManager.detectAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      return c.json({ ok: false, error: `Unknown agent: ${agentId}` }, 404);
    }
    if (!agent.available) {
      return c.json({ ok: false, error: `${agentId} is not installed` }, 400);
    }

    const startedAt = Date.now();
    try {
      const runId = await runManager.createRun({
        agentId,
        message: 'Reply with exactly: "pong"',
      });

      // Poll until terminal or timeout
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (runManager.isTerminal(runId)) {
          const info = runManager.getRunInfo(runId);
          const elapsed = Date.now() - startedAt;
          const ok = info?.status === 'succeeded';
          return c.json({
            ok,
            elapsed,
            status: info?.status ?? 'unknown',
            stopReason: info?.lastStopReason ?? null,
          });
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      // Timeout — cancel the run
      runManager.cancelRun(runId);
      const elapsed = Date.now() - startedAt;
      return c.json({ ok: false, elapsed, error: 'Test timed out after 30s' }, 408);
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      return c.json({
        ok: false,
        elapsed,
        error: (err as Error).message,
      }, 500);
    }
  });

  return app;
}
