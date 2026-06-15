import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { RunManager } from '../core/RunManager.js';
import { getAgentDef } from '../core/runtimes/registry.js';
import { installAgent } from '../core/runtimes/install.js';
import type { InstallEvent } from '@molio/contracts';

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

      // For multi-turn agents (e.g. Qwen, Claude), the process stays alive
      // after responding (stdin open for follow-up). Detect turn completion
      // via events instead of waiting for process exit.
      let turnCompleted = false;
      let turnError: string | null = null;

      const unsubscribe = runManager.onEvent(runId, (event) => {
        if (event.type === 'usage') {
          turnCompleted = true;
        } else if (event.type === 'error') {
          turnError = event.message;
          turnCompleted = true;
        }
      });

      // Poll until turn completes, process exits, or timeout
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (turnCompleted) {
          unsubscribe?.();
          runManager.cancelRun(runId);
          const elapsed = Date.now() - startedAt;
          const ok = !turnError;
          return c.json({
            ok,
            elapsed,
            status: ok ? 'succeeded' : 'failed',
            error: ok ? undefined : turnError,
          });
        }

        if (runManager.isTerminal(runId)) {
          unsubscribe?.();
          const info = runManager.getRunInfo(runId);
          const elapsed = Date.now() - startedAt;
          const ok = info?.status === 'succeeded';
          return c.json({
            ok,
            elapsed,
            status: info?.status ?? 'unknown',
            stopReason: info?.lastStopReason ?? null,
            error: ok ? undefined : (info?.error ?? null),
          });
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      // Timeout — clean up
      unsubscribe?.();
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

  // POST /:agentId/install — one-click install an agent via SSE
  app.post('/:agentId/install', (c) => {
    const agentId = c.req.param('agentId');
    const def = getAgentDef(agentId);

    if (!def) {
      return c.json({ error: `Unknown agent: ${agentId}` }, 404);
    }
    if (!def.installable) {
      return c.json({ error: `Agent ${agentId} does not support auto-install` }, 400);
    }

    // Check if already installed
    const agents = runManager.detectAgents();
    const agent = agents.find((a) => a.id === agentId);
    if (agent?.available) {
      return c.json({ error: `${agentId} is already installed` }, 400);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return stream(c, async (s) => {
      await installAgent({
        agentId,
        onEvent: (event: InstallEvent) => {
          s.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
    });
  });

  return app;
}
