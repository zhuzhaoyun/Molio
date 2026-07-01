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
 * official PowerShell iex installer). `hermes` is the TUI entry — kept as a
 * fallback binary so detection still works if only `hermes` is on PATH.
 *
 * Models: not passed via CLI args. `session/new` returns `models.availableModels`
 * dynamically; RunManager captures them and pushes to the frontend via SSE.
 * `fallbackModels` here is a static placeholder shown before the first run.
 */
export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes Agent',
  bin: 'hermes-acp',
  fallbackBins: ['hermes'],
  versionArgs: ['--version'],

  buildArgs: () => [],

  transport: 'acp-jsonrpc',
  acp: {
    promptMethod: 'session/prompt',
    cancelMethod: 'session/cancel',
    // Handshake phase (initialize + session/new): hermes-acp is chatty —
    // prints MCP/plugin loading progress to stderr throughout. 15s of total
    // silence means the process is genuinely hung.
    idleTimeoutMs: 15000,
    // Prompt phase (session/prompt): hermes goes silent while preparing the
    // LLM call (compiling system prompt, loading tool defs) and waiting for
    // the first token. Reproduced ~13s of silence on a fast machine for a
    // trivial "pong" prompt; slower machines / complex prompts need more.
    // 60s accommodates LLM latency while still catching true hangs.
    promptIdleTimeoutMs: 60000,
    // Safety-net cap so a runaway session can't block forever. Normal cold
    // starts finish in well under a minute; 5min is plenty for edge cases.
    absoluteTimeoutMs: 300000,
    cancelTimeoutMs: 5000,
  },

  // streamFormat left unset — ACP path bypasses selectParser entirely.
  multiTurn: true,

  fallbackModels: [
    { id: 'default', label: 'Default' },
  ],

  installUrl: 'https://github.com/NousResearch/hermes-agent',
};
