import type { RuntimeAgentDef } from '@molio/contracts';

/**
 * Hermes Agent — Nous Research's self-improving AI agent.
 *
 * Unlike the other runtime defs here, Hermes does NOT use stdin-prompt + JSONL stdout.
 * It exposes a long-running JSON-RPC server (Agent Client Protocol) via the
 * `hermes-acp` console script. RunManager detects `transport: 'acp-jsonrpc'` and
 * drives it through AcpTransport instead of selectParser + stdin writes.
 *
 * Binary: `hermes-acp` (Windows: `hermes-acp.exe`, a venv shim created by the
 * official PowerShell iex installer). We deliberately do NOT fall back to the
 * `hermes` TUI binary — it doesn't speak ACP, and spawning it would hang the
 * handshake until the idle timeout fires. Users without `hermes-acp` on PATH
 * see a clean "not installed" state and can install via the installUrl below.
 *
 * Models: not passed via CLI args. `session/new` returns `models.availableModels`
 * dynamically; RunManager captures them and pushes to the frontend via SSE.
 * `fallbackModels` here is a static placeholder shown before the first run.
 */
export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes Agent',
  bin: 'hermes-acp',
  versionArgs: ['--version'],

  buildArgs: () => [],

  transport: 'acp-jsonrpc',
  acp: {
    // Handshake phase (initialize + session/new): hermes-acp is chatty —
    // prints MCP/plugin loading progress to stderr throughout. 15s of total
    // silence means the process is genuinely hung.
    idleTimeoutMs: 15000,
    // Prompt phase (session/prompt): the agent can be silent for a LONG time
    // in real workflows — not just first-token latency (system prompt compile,
    // tool def loading) but also while a TOOL runs. A subprocess-based tool
    // (OCR, doc conversion, web fetch) writes to its own stdout/stderr, not
    // hermes's, so hermes produces zero output until the tool returns. A
    // 50-page OCR can take 2-3 min; complex agentic loops can run 10+ min.
    // 5min idle catches truly dead sessions while not tripping on real tool
    // execution. Users with even longer workflows can override via
    // MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS env var.
    promptIdleTimeoutMs: 300000,
    // Safety-net cap: a session should never run this long. 30min accommodates
    // the longest agentic workflows (multi-step research, large doc processing)
    // while still guaranteeing an eventual exit. The idle timer catches hangs
    // much faster in normal operation.
    absoluteTimeoutMs: 1800000,
    cancelTimeoutMs: 5000,
  },

  // streamFormat left unset — ACP path bypasses selectParser entirely.
  multiTurn: true,

  fallbackModels: [
    { id: 'default', label: 'Default' },
  ],

  installUrl: 'https://github.com/NousResearch/hermes-agent',
};
