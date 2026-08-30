import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { RunManager } from '../core/RunManager.js';
import { getAgentConfig, setAgentConfig } from '../core/config.js';
import { getAgentDef } from '../core/runtimes/registry.js';
import { installAgent } from '../core/runtimes/install.js';
import {
  applyCodexProvider,
  getCodexProviderState,
  CodexConfigError,
  type ApplyCodexProviderOpts,
} from '../core/runtimes/codex-config.js';
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
    const def = getAgentDef(agentId);
    // ACP agents (Hermes) have a slow cold start — plugin/MCP loading can
    // take well over 30s on a slow machine. Give them a longer outer budget.
    const isAcp = def?.transport === 'acp-jsonrpc';
    const timeoutMs = isAcp ? 120_000 : 30_000;

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
      // For ACP agents (Hermes), the test verifies the **handshake only**
      // (initialize + session/new) — not a full LLM turn. Reasons:
      //   1. LLM latency is environment-dependent (provider, network, model)
      //      and can exceed any reasonable idle timeout — making the test
      //      flaky for reasons unrelated to "is hermes installed correctly".
      //   2. The test button's job is to verify the runtime is installed and
      //      the ACP transport works. LLM issues surface in real chat usage.
      // The `models` event fires after session/new completes, signalling that
      // the full handshake (MCP load, plugin discovery, provider connection)
      // succeeded. For stdio-jsonl agents, keep sending "pong" as before.
      const message = isAcp ? '' : 'Reply with exactly: "pong"';
      const runId = await runManager.createRun({ agentId, message });

      let turnCompleted = false;
      let turnError: string | null = null;

      const unsubscribe = runManager.onEvent(runId, (event) => {
        if (isAcp && event.type === 'models') {
          // ACP handshake complete: initialize + session/new succeeded,
          // plugins loaded, provider connected, models returned.
          turnCompleted = true;
        } else if (!isAcp && event.type === 'usage') {
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
      return c.json({ ok: false, elapsed, error: `Test timed out after ${Math.round(timeoutMs / 1000)}s` }, 408);
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
    if (!def.install) {
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
      const ac = new AbortController();
      // Abort install when the client disconnects
      s.onAbort(() => ac.abort());

      await installAgent({
        agentId,
        signal: ac.signal,
        onEvent: (event: InstallEvent) => {
          s.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
    });
  });

  // GET /:agentId/provider — current Codex provider state (reads live ~/.codex files)
  app.get('/:agentId/provider', (c) => {
    const agentId = c.req.param('agentId');
    if (agentId !== 'codex') {
      return c.json({ error: 'Provider config is only supported for codex' }, 400);
    }
    const state = getCodexProviderState();
    // No override in live files → fall back to last preset saved in Molio config
    if (state.presetHint === 'official' && !state.model && !state.baseUrl) {
      const saved = getAgentConfig('codex').provider;
      if (saved?.presetId && saved.presetId !== 'official') {
        return c.json({ ...state, presetHint: saved.presetId });
      }
    }
    return c.json(state);
  });

  // PUT /:agentId/provider — apply Codex provider config (writes ~/.codex files)
  app.put('/:agentId/provider', async (c) => {
    const agentId = c.req.param('agentId');
    if (agentId !== 'codex') {
      return c.json({ error: 'Provider config is only supported for codex' }, 400);
    }
    let body: ApplyCodexProviderOpts;
    try {
      body = await c.req.json<ApplyCodexProviderOpts>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    try {
      applyCodexProvider(body);
    } catch (err) {
      if (err instanceof CodexConfigError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: `Failed to apply provider config: ${(err as Error).message}` }, 500);
    }
    // Persist selection meta (no secrets) for the UI's default selection.
    // ~/.codex files are already updated at this point — a persist failure
    // must surface as a JSON error (not a plain-text 500) so the UI can
    // tell the user the provider was applied but the selection wasn't saved.
    try {
      const existing = getAgentConfig('codex');
      setAgentConfig('codex', {
        ...existing,
        provider: {
          presetId: body.presetId,
          baseUrl: body.baseUrl,
          model: body.model,
          wireApi: body.wireApi,
        },
      });
    } catch (err) {
      return c.json(
        { error: `Provider applied, but failed to persist selection: ${(err as Error).message}` },
        500,
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
