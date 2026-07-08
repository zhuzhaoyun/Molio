import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentEvent, AgentInfo, RuntimeAgentDef, RunInfo, RunStatus, ChatMessage,
} from '@molio/contracts';
import { getAgentDef, listAgentDefs } from './runtimes/registry.js';
import { resolveAgentBinary, probeVersion } from './runtimes/launch.js';
import { buildSpawnEnv, createStderrDecoder } from './runtimes/env.js';
import { createClaudeStreamHandler } from './streams/claude-stream.js';
import { createCodexStreamHandler } from './streams/codex-stream.js';
import { createJsonEventStreamHandler } from './streams/json-event-stream.js';
import { AcpTransport } from './streams/acp-transport.js';
import type { StreamHandler } from '@molio/contracts';
import { createJsonlParser } from './streams/jsonl-parser.js';
import { loadConfig, getAgentConfig, buildAgentEnv } from './config.js';
import { buildTranscript, type TranscriptMessage } from './transcript.js';
import type { RunState, BufferedEvent } from '../types.js';
import { TurnTextCollector } from './turn-text-collector.js';

const TERMINAL_STATUSES = new Set<RunStatus>(['succeeded', 'failed', 'canceled']);
const MAX_EVENTS = 2_000;
const RUN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Map ACP PromptResponse.stopReason → Molio turn_end.stopReason.
 * ACP values: end_turn | max_tokens | max_turn_requests | refusal | cancelled
 */
function mapAcpStopReason(stop: string | undefined): string {
  switch (stop) {
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
    case 'cancelled':
      return stop;
    default:
      return 'end_turn';
  }
}

/**
 * Map ACP Usage → Molio UsageInfo. Field names are unstable (ACP spec marks
 * Usage as UNSTABLE), so read defensively across snake/camel variants.
 */
function mapAcpUsage(u: any): import('@molio/contracts').UsageInfo {
  const out: import('@molio/contracts').UsageInfo = {};
  if (typeof u?.input_tokens === 'number') out.input_tokens = u.input_tokens;
  else if (typeof u?.inputTokens === 'number') out.input_tokens = u.inputTokens;
  if (typeof u?.output_tokens === 'number') out.output_tokens = u.output_tokens;
  else if (typeof u?.outputTokens === 'number') out.output_tokens = u.outputTokens;
  if (typeof u?.thought_tokens === 'number') out.thought_tokens = u.thought_tokens;
  else if (typeof u?.thoughtTokens === 'number') out.thought_tokens = u.thoughtTokens;
  if (typeof u?.cached_read_tokens === 'number') out.cached_read_tokens = u.cached_read_tokens;
  else if (typeof u?.cachedReadTokens === 'number') out.cached_read_tokens = u.cachedReadTokens;
  if (typeof u?.cached_write_tokens === 'number') out.cached_write_tokens = u.cached_write_tokens;
  else if (typeof u?.cachedWriteTokens === 'number') out.cached_write_tokens = u.cachedWriteTokens;
  return out;
}

/**
 * Build a system-hint prefix that tells the agent CLI which runtime
 * it is running as inside Molio.  Prepended to the first user message.
 */
export function buildRuntimeHint(def: RuntimeAgentDef): string {
  return `<system-hint>You are running as "${def.name}" (id: ${def.id}) inside Molio. When the user asks which AI runtime or agent is active, tell them this.</system-hint>\n\n`;
}

export interface CreateRunOptions {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
  projectId?: string;
  conversationId?: string;
  assistantMessageId?: string;
  /** Prior conversation messages for transcript building (multi-turn). */
  history?: ChatMessage[];
  /** Called when a turn completes with accumulated text content. */
  onTurnComplete?: (text: string, runId: string) => void;
  /**
   * Path to a file whose contents are appended to the agent's built-in system
   * prompt at spawn time (e.g. the wiki/vault role frame, materialized by
   * `ensureWikiSysPromptFiles`). Only consumed on a fresh spawn — multi-turn
   * follow-ups reuse the same process, which already carries it from turn 1.
   */
  appendSystemPromptFile?: string;
}

export class RunManager {
  private runs = new Map<string, RunState>();
  private runsLogDir: string;

  constructor() {
    this.runsLogDir = path.join(os.homedir(), '.molio', 'runs');
  }

  detectAgents(): AgentInfo[] {
    const config = loadConfig();
    return listAgentDefs().map((def) => {
      const agentConfig = config.agents[def.id] || {};
      const configuredEnv = agentConfig.env || {};
      const result = resolveAgentBinary(def, { configuredEnv });
      let available = result.binary !== null;
      let binary = result.binary;
      let version: string | null = null;

      let probeError: string | null = null;
      if (result.binary) {
        const probeResult = probeVersion(result.binary, def.versionArgs);
        version = probeResult.version;
        probeError = probeResult.error ?? null;

        // A binary that exists on disk but can't execute is NOT usable.
        // This handles stale/broken binaries left by failed installs —
        // the file is found in a well-known dir but can't actually run.
        if (!probeResult.version && probeResult.error) {
          available = false;
        }
      }

      return {
        id: def.id,
        name: def.name,
        available,
        binary,
        source: result.source,
        version,
        probeError: probeError,
        models: def.fallbackModels,
        installUrl: def.installUrl,
        installable: !!def.install,
      };
    });
  }

  listAgents(): AgentInfo[] {
    return this.detectAgents();
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  getRunInfo(runId: string): RunInfo | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      createdAt: run.createdAt,
      lastStopReason: run.lastStopReason,
      error: run.error,
    };
  }

  getRunContext(runId: string): { agentId: string; conversationId: string | null } | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      agentId: run.agentId,
      conversationId: run.conversationId,
    };
  }

  listRuns(): RunInfo[] {
    return Array.from(this.runs.values()).map((run) => ({
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      createdAt: run.createdAt,
      lastStopReason: run.lastStopReason,
      error: run.error,
    }));
  }

  onEvent(runId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.eventListeners.add(callback);
    return () => { run.eventListeners.delete(callback); };
  }

  /**
   * Get buffered events for SSE replay. Returns events with id > afterId.
   */
  getBufferedEvents(runId: string, afterId: number = 0): BufferedEvent[] | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return run.events.filter((e) => e.id > afterId);
  }

  /**
   * Check if a run is in a terminal state.
   */
  isTerminal(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return TERMINAL_STATUSES.has(run.status);
  }

  /**
   * Get the last event id for a run (nextEventId - 1).
   */
  getLastEventId(runId: string): number {
    const run = this.runs.get(runId);
    if (!run) return 0;
    return run.nextEventId - 1;
  }

  async createRun(opts: CreateRunOptions): Promise<string> {
    const def = getAgentDef(opts.agentId);
    if (!def) throw new Error(`Unknown agent: ${opts.agentId}`);

    const agentConfig = getAgentConfig(opts.agentId);
    const configuredEnv = agentConfig.env || {};
    const result = resolveAgentBinary(def, { configuredEnv });

    if (!result.binary) {
      throw new Error(
        `Binary not found for ${def.name}. Install it or set ${def.id.toUpperCase()}_BIN env var.`
        + (def.installUrl ? `\nInstall: ${def.installUrl}` : ''),
      );
    }

    const runId = randomUUID();
    const now = Date.now();
    const eventsLogPath = path.join(this.runsLogDir, runId, 'events.jsonl');

    const run: RunState = {
      id: runId,
      agentId: opts.agentId,
      status: 'running',
      child: null,
      stdinOpen: false,
      pendingHostAnswers: new Set(),
      lastStopReason: null,
      eventListeners: new Set(),
      createdAt: now,
      // Phase 1 additions
      projectId: opts.projectId ?? null,
      conversationId: opts.conversationId ?? null,
      assistantMessageId: opts.assistantMessageId ?? null,
      events: [],
      nextEventId: 1,
      eventsLogPath,
      eventsLogStream: null,
      updatedAt: now,
      exitCode: null,
      error: null,
      errorCode: null,
      turnText: new TurnTextCollector(runId, opts.onTurnComplete),
    };
    this.runs.set(runId, run);

    const mergedEnv = buildAgentEnv(opts.agentId, agentConfig);
    const env = buildSpawnEnv(def, mergedEnv);
    env['MOLIO_RUN_ID'] = runId;

    const args = def.buildArgs(
      opts.message,
      {
        model: opts.model,
        // Path to a file with the wiki/vault role frame (materialized at
        // daemon startup by ensureWikiSysPromptFiles). Passed as
        // --append-system-prompt-file <path> — NOT inline text, which broke
        // argv parsing on Windows and ate --dangerously-skip-permissions.
        appendSystemPromptFile: opts.appendSystemPromptFile,
      },
      { cwd: opts.cwd },
    );

    const stdinMode = def.promptViaStdin || def.transport === 'acp-jsonrpc' ? 'pipe' : 'ignore';
    const isCmd = process.platform === 'win32' && (result.binary.endsWith('.cmd') || result.binary.endsWith('.bat'));
    // On Windows with shell: true, Node.js concatenates args with spaces.
    // Wrap args containing spaces in double quotes so they remain single arguments.
    const spawnArgs = isCmd
      ? args.map((arg) => {
          if (arg.includes(' ') || arg.includes('"')) {
            return `"${arg.replace(/"/g, '\\"')}"`;
          }
          return arg;
        })
      : args;
    const child: ChildProcess = spawn(result.binary, spawnArgs, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd(),
      // On Windows, .cmd/.bat files must be spawned with shell: true to avoid EINVAL
      shell: isCmd,
      windowsVerbatimArguments: process.platform === 'win32' && !isCmd,
    });
    run.child = child;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.emitEvent(run, { type: 'error', message: `stdin error: ${err.message}` });
    });

    child.stdout?.setEncoding('utf8');
    const stderrDecoder = createStderrDecoder();

    if (def.transport === 'acp-jsonrpc') {
      // ── ACP path (Hermes) — long-running JSON-RPC server over stdio ──
      // No stdin prompt, no selectParser. Drive initialize/session/new/session/prompt via AcpTransport.
      // ACP schema requires cwd to be absolute; resolve against process.cwd()
      // so a relative MOLIO_CWD env var doesn't silently break session/new.
      const acpCwd = path.resolve(opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd());
      this.initAcp(run, def, child, acpCwd)
        .then(() => {
          // After init, drive the first session/prompt with the user's message.
          // Subsequent turns go through sendMessage.
          if (opts.message && run.acp) {
            this.sendMessage(runId, opts.message);
          }
        })
        .catch((err) => {
          // Initialization already emitted its own error event; just ensure the run is finished.
          if (!TERMINAL_STATUSES.has(run.status)) {
            this.finishRun(run, 'failed', 1, null);
          }
          this.emitEvent(run, { type: 'error', message: `ACP init failed: ${err.message}` });
        });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = stderrDecoder ? stderrDecoder(chunk) : chunk.toString('utf8');
        // stderr counts as activity — reset idle timers on pending ACP requests
        // so cold-start plugin loading doesn't trip the timeout.
        run.acp?.transport.noteActivity();
        this.handleAcpStderr(run, text);
      });

      child.on('error', (err) => {
        this.emitEvent(run, { type: 'error', message: `Spawn error: ${err.message}` });
        this.finishRun(run, 'failed', 1, null);
      });

      child.on('close', (code) => {
        run.acp?.transport.flush();
        const hadPending = run.acp?.transport.hasPending() ?? false;
        const wasCancelled = run.acp
          ? run.acp.transport.isCancelled(run.acp.sessionId)
          : false;
        run.acp?.transport.rejectAll(new Error(`hermes-acp process exited (code=${code})`));
        // ACP runs are long-running — the process exiting is never a "clean
        // success" on its own. Decide terminal status by what triggered it:
        //   - cancelRun marked the session → 'canceled'
        //   - prompt was in-flight when the process died → 'failed' (mid-prompt crash)
        //   - otherwise (clean shutdown after a normal turn) → fall back to exit code
        //     so a graceful agent-initiated exit still resolves as succeeded.
        let status: 'succeeded' | 'failed' | 'canceled';
        if (wasCancelled) {
          status = 'canceled';
        } else if (hadPending) {
          status = 'failed';
        } else {
          status = code === 0 ? 'succeeded' : 'failed';
        }
        this.finishRun(run, status, code, null);
      });

      return runId;
    }

    // ── stdio-jsonl path (Claude/Codex/Gemini/Qwen) — existing behavior ──

    // Runtime identity hint — prepended to the first message so the agent
    // CLI knows which runtime it is running as inside Molio.
    const runtimeHint = buildRuntimeHint(def);

    if (def.promptViaStdin && child.stdin) {
      const prompt = this.composePrompt(runtimeHint + opts.message, opts.history, opts.agentId);
      if (def.promptInputFormat === 'stream-json') {
        // Pattern A: Stream-JSON agent — interactive stdin, stays open for multi-turn
        const msg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: prompt },
        });
        child.stdin.write(msg + '\n', 'utf8');
        run.stdinOpen = true;
      } else {
        // Pattern B: Non-stream-json agent — build transcript + new message, close stdin
        child.stdin.end(prompt);
        run.stdinOpen = false;
      }
    }

    const parser = this.selectParser(def, (ev) => {
      // Terminal guard: once the run is canceled/finished, ignore any late
      // events parsed from buffered stdout of the dying child. This prevents
      // a late turn_end from triggering emitEvent → turnText.flush() →
      // onTurnComplete (which would append an orphan assistant reply after
      // the conversation has been truncated + a new run started).
      if (TERMINAL_STATUSES.has(run.status)) return;

      this.emitEvent(run, ev);

      if (run.stdinOpen && ev.type === 'tool_use' && ev.name === 'AskUserQuestion') {
        run.pendingHostAnswers.add(ev.id);
      }

      if (ev.type === 'turn_end') {
        run.lastStopReason = ev.stopReason;
        this.maybeCloseStdin(run);
      }

      if (ev.type === 'usage') {
        this.maybeCloseStdin(run);
      }
    });

    child.stdout?.on('data', (chunk: string) => {
      parser.feed(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder ? stderrDecoder(chunk) : chunk.toString('utf8');
      const trimmed = text.trim();
      // Codex CLI logs "Reading prompt from stdin..." and "Reading additional
      // input from stdin..." to stderr as informational messages, not errors.
      // Filter them out so they don't show up as red error bubbles in the UI.
      const isCodexInfoStderr = def.id === 'codex' && (
        trimmed.includes('Reading prompt from stdin') ||
        trimmed.includes('Reading additional input from stdin')
      );
      if (trimmed && !isCodexInfoStderr) {
        this.emitEvent(run, { type: 'error', message: trimmed });
      }
    });

    child.on('error', (err) => {
      this.emitEvent(run, { type: 'error', message: `Spawn error: ${err.message}` });
      this.finishRun(run, 'failed', 1, null);
    });

    child.on('close', (code) => {
      parser.flush();
      this.finishRun(run, code === 0 ? 'succeeded' : 'failed', code, null);
    });

    return runId;
  }

  /**
   * ACP initialization — runs after spawn, drives initialize + session/new.
   * Fire-and-forget from createRun so runId is returned immediately; failures
   * emit error events and finish the run. On success, sets run.acp and pushes
   * models to the frontend.
   */
  private async initAcp(
    run: RunState,
    def: RuntimeAgentDef,
    child: ChildProcess,
    cwd: string,
  ): Promise<void> {
    const transport = new AcpTransport(
      (json) => {
        if (child.stdin?.writable) child.stdin.write(json, 'utf8');
      },
      (ev) => this.emitEvent(run, ev),
    );

    // Assign to run.acp early (sessionId filled in after session/new) so the
    // stderr handler in createRun can reset the transport's idle timer during
    // initialize / session/new — before this, run.acp was undefined and stderr
    // activity during cold start wouldn't reset the timeout.
    run.acp = { transport, sessionId: '' };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => transport.feed(chunk));

    const acp = def.acp!;
    // Test escape hatch: env overrides for ACP timeouts so integration tests
    // don't have to wait the full 15s idle / 5min absolute defaults.
    const idleTimeout = Number(process.env.MOLIO_ACP_IDLE_TIMEOUT_MS) ||
      acp.idleTimeoutMs || 15000;
    const absoluteTimeout = Number(process.env.MOLIO_ACP_ABSOLUTE_TIMEOUT_MS) ||
      acp.absoluteTimeoutMs || 300000;

    // initialize
    await transport.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      { idleTimeoutMs: idleTimeout, absoluteTimeoutMs: absoluteTimeout },
    );

    // session/new — slow (loads plugins, connects provider).
    // cwd is required by ACP schema ("Must be an absolute path").
    const session: any = await transport.request(
      'session/new',
      { mcpServers: [], cwd },
      { idleTimeoutMs: idleTimeout, absoluteTimeoutMs: absoluteTimeout },
    );
    const sessionId: string = session?.sessionId;
    if (!sessionId) {
      throw new Error('session/new returned no sessionId');
    }
    run.acp.sessionId = sessionId;

    // Capture available models for the frontend
    const models: any = session?.models?.availableModels;
    if (Array.isArray(models)) {
      run.acpModels = models.map((m: any) => ({
        modelId: String(m.modelId),
        name: String(m.name ?? m.modelId),
      }));
      this.emitEvent(run, {
        type: 'models',
        models: run.acpModels.map((m) => ({ id: m.modelId, label: m.name })),
        currentModelId: typeof session?.models?.currentModelId === 'string'
          ? session.models.currentModelId
          : undefined,
      });
    }

    this.emitEvent(run, { type: 'status', label: 'running' });
  }

  /**
   * Hermes stderr is verbose (plugin registration, provider connection, MCP tools).
   * Drop INFO/WARNING/DEBUG log lines; only surface ERROR + Python tracebacks as error events.
   */
  private handleAcpStderr(run: RunState, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Hermes log format: YYYY-MM-DD HH:MM:SS [LEVEL] logger: message
    const isLogLevel = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(INFO|WARNING|DEBUG)\]/;
    if (isLogLevel.test(trimmed)) return;
    this.emitEvent(run, { type: 'error', message: trimmed });
  }

  /**
   * Flush any accumulated assistant text for the given run.
   * Call this BEFORE inserting a new user message to ensure correct
   * position ordering in the database (assistant reply < next user message).
   */
  flushPendingReply(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.turnText.flush();
  }

  /**
   * Whether a run is still alive and can accept a follow-up message via
   * sendMessage() — i.e. it is a multi-turn agent whose stdin is still open
   * and writable, and the run has not reached a terminal status.
   *
   * Non-throwing precheck so callers (e.g. WeixinService) can decide between
   * reusing an existing multi-turn session and spawning a fresh run without
   * catching sendMessage()'s thrown error.
   */
  canAcceptMessage(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (TERMINAL_STATUSES.has(run.status)) return false;
    const def = getAgentDef(run.agentId);
    if (!def?.multiTurn) return false;
    return run.stdinOpen && !!run.child?.stdin?.writable;
  }

  /**
   * Send a follow-up user message to an active run (multi-turn).
   * Writes to the existing stdin stream for stream-json agents.
   *
   * NOTE: Caller should invoke flushPendingReply() before inserting
   * the user message into the DB to maintain correct ordering.
   */
  sendMessage(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const def = getAgentDef(run.agentId);

    if (def?.transport === 'acp-jsonrpc') {
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new Error('Run is already in a terminal state — start a new run instead');
      }
      if (!run.acp) throw new Error('ACP session not initialized');
      const { transport, sessionId } = run.acp;
      // initAcp sets sessionId='' before session/new resolves; if session/new
      // failed, run.acp exists but sessionId is empty. Guard against sending
      // a malformed session/prompt with an empty sessionId.
      if (!sessionId) throw new Error('ACP session not initialized — sessionId is empty');
      const acp = def.acp!;
      // Prompt phase uses a longer idle timeout than handshake — hermes goes
      // silent while waiting for the LLM to respond (compiling system prompt,
      // loading tool defs, first-token latency).
      const promptIdle = Number(process.env.MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS) ||
        acp.promptIdleTimeoutMs || 60000;
      const absoluteTimeout = Number(process.env.MOLIO_ACP_ABSOLUTE_TIMEOUT_MS) ||
        acp.absoluteTimeoutMs || 300000;
      // Fire-and-forget: events flow in via session/update notifications during the await;
      // turn_end is emitted when the prompt response arrives.
      transport.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: message }] },
        { idleTimeoutMs: promptIdle, absoluteTimeoutMs: absoluteTimeout },
      )
        .then((resp: any) => {
          this.emitEvent(run, {
            type: 'turn_end',
            stopReason: mapAcpStopReason(resp?.stopReason),
          });
          if (resp?.usage) {
            this.emitEvent(run, { type: 'usage', usage: mapAcpUsage(resp.usage) });
          }
          transport.unmarkCancelled(sessionId);
        })
        .catch((err: Error) => {
          // If the session was cancelled, the cancel flow already handles termination — don't spam errors.
          if (transport.isCancelled(sessionId)) return;
          this.emitEvent(run, { type: 'error', message: `prompt failed: ${err.message}` });
          // Without finishRun here, the run stays in 'running' until the 30-min
          // TTL cleanup fires — the UI shows a spinner forever after a prompt failure.
          this.finishRun(run, 'failed', 1, null);
        });
      return;
    }

    if (!run.child?.stdin?.writable || !run.stdinOpen) {
      throw new Error('Run not active or stdin closed — start a new run instead');
    }

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    });
    run.child.stdin.write(msg + '\n', 'utf8');
  }

  submitToolResult(runId: string, toolUseId: string, content: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const def = getAgentDef(run.agentId);

    if (def?.transport === 'acp-jsonrpc') {
      throw new Error('ACP transport does not support host tool results — Hermes executes tools internally');
    }

    if (!run.child?.stdin?.writable || !run.stdinOpen) {
      throw new Error('Run not active or stdin closed');
    }

    const msg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: false,
        }],
      },
    });
    run.child.stdin.write(msg + '\n', 'utf8');
    run.pendingHostAnswers.delete(toolUseId);
    this.maybeCloseStdin(run);
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const def = getAgentDef(run.agentId);

    // Synchronously mark the run terminal so that:
    //  (a) isTerminal(runId) returns true immediately — lets callers (e.g.
    //      rewind-resend) safely truncate + start a new run without a late
    //      onTurnComplete from the dying run appending an orphan reply.
    //  (b) the parser callback's terminal guard short-circuits any late
    //      stream events (including turn_end → onTurnComplete) from buffered
    //      stdout of the killed child.
    // We do this BEFORE flushing so the defense-in-depth gate in
    // run-starter.ts:onTurnComplete (which checks isTerminal) blocks the
    // append. Local onTurnComplete callbacks that don't check isTerminal
    // (e.g. the shutdown-flush path) still receive the buffered text.
    const wasTerminal = TERMINAL_STATUSES.has(run.status);
    if (!wasTerminal) {
      run.status = 'canceled';
      run.stdinOpen = false;
      run.updatedAt = Date.now();
    }

    // Flush any accumulated text before killing the process.
    run.turnText.flush();

    if (def?.transport === 'acp-jsonrpc' && run.acp) {
      const { transport, sessionId } = run.acp;
      transport.markCancelled(sessionId);
      const cancelTimeout = def.acp?.cancelTimeoutMs ?? 5000;
      // Cancel is a short ack — strict absolute deadline, no idle timer.
      transport.request('session/cancel', { sessionId }, { absoluteTimeoutMs: cancelTimeout })
        .catch(() => { /* cancel itself failed — fall through to SIGTERM */ })
        .finally(() => {
          if (run.child && !run.child.killed) {
            run.child.kill('SIGTERM');
            setTimeout(() => {
              if (run.child && !run.child.killed) run.child.kill('SIGKILL');
            }, 5000);
          }
        });
      return;
    }

    if (run.child && !run.child.killed) {
      run.child.kill('SIGTERM');
      setTimeout(() => {
        if (run.child && !run.child.killed) {
          run.child.kill('SIGKILL');
        }
      }, 5000);
    }
    if (run.stdinOpen && run.child?.stdin?.writable) {
      try { run.child.stdin.end(); } catch { /* ignore */ }
      run.stdinOpen = false;
    }

    // Emit the canceled status event so SSE listeners (frontend EventSource)
    // close cleanly. Mirror how finishRun emits succeeded/failed status. Only
    // emit if we transitioned in this call (avoid duplicate on repeated cancel).
    if (!wasTerminal) {
      this.emitEvent(run, { type: 'status', label: 'canceled' });
      // Close the JSONL log stream — the child's later 'close' handler will
      // call finishRun, which short-circuits via the terminal guard.
      try { run.eventsLogStream?.end(); } catch { /* ignore */ }
      run.eventsLogStream = null;
    }
  }

  cancelAll(): void {
    for (const [id] of this.runs) {
      this.cancelRun(id);
    }
  }

  /**
   * Emit an event: buffer it, write to JSONL log, and fan out to listeners.
   */
  private emitEvent(run: RunState, event: AgentEvent): void {
    // Track error details
    if (event.type === 'error') {
      run.error = event.message;
    }

    // Accumulate text for turn-complete persistence
    if (event.type === 'text_delta') {
      run.turnText.append(event.delta);
    }

    // Flush on turn completion or terminal status
    if (event.type === 'turn_end' && event.stopReason !== 'tool_use') {
      run.turnText.flush();
    } else if (event.type === 'status' && (event.label === 'completed' || event.label === 'failed')) {
      run.turnText.flush();
    }

    // Buffer the event
    const id = run.nextEventId++;
    const record: BufferedEvent = {
      id,
      event: event.type,
      data: event,
      timestamp: Date.now(),
    };
    run.events.push(record);
    if (run.events.length > MAX_EVENTS) {
      run.events.splice(0, run.events.length - MAX_EVENTS);
    }
    run.updatedAt = Date.now();

    // Write to JSONL log (best-effort)
    this.ensureLogStream(run)?.write(JSON.stringify(record) + '\n');

    // Fan out to listeners
    for (const listener of run.eventListeners) {
      try { listener(event); } catch { /* listener error, skip */ }
    }
  }

  /**
   * Finish a run: set terminal status, emit end event, close log stream, schedule cleanup.
   */
  private finishRun(
    run: RunState,
    status: 'succeeded' | 'failed' | 'canceled',
    code: number | null,
    signal: string | null,
  ): void {
    if (TERMINAL_STATUSES.has(run.status)) return;

    run.status = status;
    run.exitCode = code;
    run.stdinOpen = false;
    run.updatedAt = Date.now();

    // If the run failed with a tracked error that hasn't been sent yet, emit it
    // so the frontend can display it. Skip if an error event was already emitted
    // (e.g. from stderr handler) to avoid duplicate messages.
    if (status === 'failed' && run.error) {
      const alreadyEmitted = run.events.some(
        (e) => e.event === 'error',
      );
      if (!alreadyEmitted) {
        this.emitEvent(run, { type: 'error', message: run.error });
      }
    }

    // Emit end event
    this.emitEvent(run, {
      type: 'status',
      label: status === 'succeeded' ? 'completed' : status,
    });

    // Close the JSONL log stream
    try { run.eventsLogStream?.end(); } catch { /* ignore */ }
    run.eventsLogStream = null;

    // Schedule cleanup: remove from memory after TTL
    setTimeout(() => {
      if (TERMINAL_STATUSES.has(run.status)) {
        this.runs.delete(run.id);
      }
    }, RUN_TTL_MS).unref?.();
  }

  /**
   * Lazily create the JSONL log stream for a run.
   */
  private ensureLogStream(run: RunState): WriteStream | null {
    if (!run.eventsLogPath) return null;
    if (run.eventsLogStream) return run.eventsLogStream;

    try {
      mkdirSync(path.dirname(run.eventsLogPath), { recursive: true });
      run.eventsLogStream = createWriteStream(run.eventsLogPath, { flags: 'a' });
      run.eventsLogStream.on('error', () => {
        try { run.eventsLogStream?.destroy(); } catch { /* ignore */ }
        run.eventsLogStream = null;
      });
      return run.eventsLogStream;
    } catch {
      return null;
    }
  }

  private maybeCloseStdin(run: RunState): void {
    if (run.pendingHostAnswers.size > 0) return;
    if (run.lastStopReason === 'tool_use') return;

    // Multi-turn agents (e.g. Claude Code with stream-json stdin) keep stdin
    // open between turns so follow-up messages can be sent to the same process.
    // Only close stdin on cancelRun() or when the child process exits.
    const def = getAgentDef(run.agentId);
    if (def?.multiTurn) return;

    if (run.child?.stdin?.writable && run.stdinOpen) {
      try { run.child.stdin.end(); } catch { /* ignore */ }
      run.stdinOpen = false;
    }
  }

  /**
   * Compose the full prompt for non-stream-json agents.
   * Combines conversation history (transcript) with the new user message.
   */
  private composePrompt(
    message: string,
    history?: ChatMessage[],
    agentId?: string,
  ): string {
    if (!history || history.length === 0) {
      return message;
    }

    // Convert ChatMessage[] to TranscriptMessage[]
    const transcriptHistory: TranscriptMessage[] = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        agentId: m.agentId,
      }));

    const transcript = buildTranscript(transcriptHistory, agentId);
    if (!transcript) return message;

    return `${transcript}\n\n## user\n${message}`;
  }

  private selectParser(
    def: RuntimeAgentDef,
    onEvent: (ev: AgentEvent) => void,
  ): StreamHandler {
    if (def.streamFormat === 'claude-stream-json') {
      return createClaudeStreamHandler(onEvent);
    }
    if (def.streamFormat === 'json-event-stream') {
      // Use multi-kind dispatcher for all json-event-stream agents
      return createJsonEventStreamHandler(def.eventParser ?? 'unknown', onEvent);
    }
    // Plain text or unrecognized format — pass through as raw
    return createJsonlParser((line: string) => {
      onEvent({ type: 'raw', line });
    });
  }
}
