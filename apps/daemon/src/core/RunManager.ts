import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentEvent, AgentInfo, RuntimeAgentDef, RunInfo, RunStatus, ChatMessage,
} from '@molio/contracts';
import { getAgentDef, listAgentDefs } from './runtimes/registry.js';
import { TranscriptWatcher, claudeProjectDir } from './activity/transcript-watcher.js';
import {
  resolveAgentBinary, probeVersion, needsShellOnWindows,
  resolveAgentBinaryAsync, probeVersionAsync,
  type ResolveResult, type ProbeResult, type ResolveOptions,
} from './runtimes/launch.js';
import { buildSpawnEnv, createStderrDecoder } from './runtimes/env.js';
import { classifyStderrChunk } from './runtimes/stderr.js';
import { agentErrorHint } from './runtimes/error-hints.js';
import { killAgentProcessTree } from './runtimes/kill-tree.js';
import { resolveClaudeModels } from './runtimes/claude-models.js';
import { createClaudeStreamHandler } from './streams/claude-stream.js';
import { createCodexStreamHandler } from './streams/codex-stream.js';
import { createJsonEventStreamHandler } from './streams/json-event-stream.js';
import { AcpPool, type AcpSpawnSpec, type PoolEntry } from './streams/acp-pool.js';
import { formatAcpInitFailure } from './acp-errors.js';
import { ensureAcpExtra, HermesRepairError } from './runtimes/hermes.js';
import { resolveHermesHome } from './runtimes/hermes-config.js';
import type { StreamHandler } from '@molio/contracts';
import { createJsonlParser } from './streams/jsonl-parser.js';
import { loadConfig, getAgentConfig, buildAgentEnv, type AgentConfig } from './config.js';
import { buildTranscript, type TranscriptMessage } from './transcript.js';
import type { RunState, BufferedEvent } from '../types.js';
import { TurnTextCollector, type PersistedToolEvent } from './turn-text-collector.js';
import { dbgLog } from './debug-log.js';
import { ThrottledWarn } from './throttled-warn.js';

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
 * Parse the dsh-style `configOptions` shape returned by session/new into a
 * flat model list. Returns null when the session carries no model select
 * (hermes uses session.models instead).
 *
 * dsh's model configOption is a grouped select; each leaf option's `value`
 * is a JSON-encoded [provider, model] tuple string, e.g.
 * '["deepseek-official","deepseek-v4-pro"]'. The tuple's model slug becomes
 * the entry id (matching dshAgentDef.fallbackModels ids); `name` is the
 * display label. `value` is kept verbatim — session/set_config_option wants
 * the exact tuple string back.
 */
function parseConfigOptionsModels(session: any): {
  entries: { id: string; label: string; value: string }[];
  currentSlug?: string;
} | null {
  const configOptions: any = session?.configOptions;
  if (!Array.isArray(configOptions)) return null;
  const modelOption = configOptions.find(
    (o: any) => o && (o.category === 'model' || o.id === 'model') && o.type === 'select',
  );
  if (!modelOption || !Array.isArray(modelOption.options)) return null;

  // Flatten grouped options ({group, name, options:[…]}) and bare leaves.
  const leaves: any[] = [];
  for (const opt of modelOption.options) {
    if (Array.isArray(opt?.options)) leaves.push(...opt.options);
    else if (opt && typeof opt.value === 'string') leaves.push(opt);
  }

  const slugOf = (value: string): string | null => {
    try {
      const tuple = JSON.parse(value);
      if (Array.isArray(tuple) && typeof tuple[1] === 'string') return tuple[1];
    } catch { /* not a tuple — fall back to the display name below */ }
    return null;
  };

  const entries: { id: string; label: string; value: string }[] = [];
  for (const leaf of leaves) {
    if (typeof leaf?.value !== 'string') continue;
    const label = typeof leaf.name === 'string' && leaf.name ? leaf.name : leaf.value;
    entries.push({ id: slugOf(leaf.value) ?? label, label, value: leaf.value });
  }
  if (entries.length === 0) return null;

  const currentSlug = typeof modelOption.currentValue === 'string'
    ? (slugOf(modelOption.currentValue) ?? undefined)
    : undefined;
  return { entries, currentSlug };
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
  /**
   * Called when a turn completes with accumulated text and the tool events
   * that ran during this turn (assembled ToolEvents — use/result pairs).
   * Tools let the persistence layer store the assistant message's own
   * process record (messages.events_json), powering history reload of
   * work visibility (output panel / evidence jump).
   */
  onTurnComplete?: (text: string, tools: PersistedToolEvent[], runId: string) => void;
}

/** Injectable hooks for agent detection — tests override these to avoid
 * spawning real CLI processes; production defaults to the launch.ts impls. */
export interface AgentDetectDeps {
  resolve?: (def: RuntimeAgentDef, options?: ResolveOptions) => Promise<ResolveResult>;
  probe?: (bin: string, args: string[], timeoutMs?: number) => Promise<ProbeResult>;
  now?: () => number;
}

/** Default TTL for the agent-detection cache. Override via env (0 disables). */
const DEFAULT_AGENT_CACHE_TTL_MS = 30_000;

export class RunManager {
  private runs = new Map<string, RunState>();
  private runsLogDir: string;
  /**
   * Shared warm-process pool for ACP agents (hermes/dsh): one long-running
   * process per agentId, one ACP session per run. New conversations / retries /
   * page reloads reuse the warm process instead of paying the ~14s cold start.
   * The pool owns process lifecycle (spawn/initialize, crash handling, idle
   * eviction); RunManager owns session lifecycle (session/new, prompt, cancel).
   */
  private readonly acpPool = new AcpPool();
  // Throttles the per-event "emit listeners=0" diagnostic per run — kept on the
  // dbgLog channel (stdout + debug file, NOT stderr) so it never reads as ERROR.
  private readonly noSubscriberWarn = new ThrottledWarn({ sink: (m) => dbgLog(m) });

  private readonly detectDeps: AgentDetectDeps;
  /** TTL cache for detectAgentsAsync — probing spawns CLI processes (cold
   * Claude start = 1-3s), so back-to-back GET /api/agents must not re-probe. */
  private agentCache: { at: number; agents: AgentInfo[] } | null = null;
  /** In-flight dedup — concurrent callers share one probe round. */
  private agentProbeInFlight: Promise<AgentInfo[]> | null = null;

  constructor(detectDeps: AgentDetectDeps = {}) {
    this.runsLogDir = path.join(os.homedir(), '.molio', 'runs');
    this.detectDeps = detectDeps;
  }

  /**
   * @deprecated Sync variant kept for internal/legacy callers — it blocks the
   * event loop while spawning `where`/CLI probes. Use {@link detectAgentsAsync}.
   */
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

      return this.toAgentInfo(def, result, { version, error: probeError ?? undefined }, configuredEnv);
    });
  }

  /**
   * Non-blocking agent detection with a short TTL cache. All agents are
   * resolved + version-probed **in parallel** via async spawns, so the total
   * cost is ~max(single probe) instead of sum, and the daemon event loop stays
   * responsive (other first-screen requests aren't queued behind it).
   *
   * Cache invalidation: TTL (default 30s, `MOLIO_AGENT_CACHE_TTL_MS`, 0 =
   * always re-probe) + explicit {@link invalidateAgentCache} from the install
   * and config-write routes so a freshly installed/configured agent shows up
   * immediately.
   */
  async detectAgentsAsync(): Promise<AgentInfo[]> {
    const now = (this.detectDeps.now ?? Date.now)();
    const ttl = this.agentCacheTtlMs();
    if (ttl > 0 && this.agentCache && now - this.agentCache.at < ttl) {
      return this.agentCache.agents;
    }
    if (this.agentProbeInFlight) return this.agentProbeInFlight;

    const promise = this.runAgentDetection().finally(() => {
      this.agentProbeInFlight = null;
    });
    this.agentProbeInFlight = promise;
    return promise;
  }

  /** Drop the detection cache — next detectAgentsAsync re-probes. */
  invalidateAgentCache(): void {
    this.agentCache = null;
  }

  private agentCacheTtlMs(): number {
    const raw = process.env['MOLIO_AGENT_CACHE_TTL_MS'];
    if (raw === undefined || raw.trim() === '') return DEFAULT_AGENT_CACHE_TTL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AGENT_CACHE_TTL_MS;
  }

  private async runAgentDetection(): Promise<AgentInfo[]> {
    const resolve = this.detectDeps.resolve ?? resolveAgentBinaryAsync;
    const probe = this.detectDeps.probe ?? probeVersionAsync;
    const config = loadConfig();
    const agents = await Promise.all(
      listAgentDefs().map(async (def) => {
        const agentConfig = config.agents[def.id] || {};
        const configuredEnv = agentConfig.env || {};
        const result = await resolve(def, { configuredEnv });
        let probeResult: ProbeResult = { version: null };
        if (result.binary) {
          probeResult = await probe(result.binary, def.versionArgs);
        }
        return this.toAgentInfo(def, result, probeResult, configuredEnv);
      }),
    );
    this.agentCache = { at: (this.detectDeps.now ?? Date.now)(), agents };
    return agents;
  }

  /** Shared sync/async AgentInfo assembly — availability semantics live here:
   * a binary that exists on disk but fails its version probe is NOT usable
   * (stale/broken installs must not surface as available). */
  private toAgentInfo(
    def: RuntimeAgentDef,
    result: ResolveResult,
    probeResult: ProbeResult,
    configuredEnv: Record<string, string> = {},
  ): AgentInfo {
    let available = result.binary !== null;
    if (result.binary && !probeResult.version && probeResult.error) {
      available = false;
    }

    // claude 特有：从 ~/.claude/settings.json（CC Switch 等写入）解析真实
    // 模型视图——静态 fallbackModels 与第三方端点的实际接入对不上。
    // 合并顺序 settings.json → Molio agent env → 进程 env，与 spawn 一致。
    let models = def.fallbackModels;
    let defaultModel: AgentInfo['defaultModel'];
    if (def.id === 'claude') {
      const mergedEnv: Record<string, string> = { ...configuredEnv };
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') mergedEnv[k] = v;
      }
      const resolved = resolveClaudeModels({ env: mergedEnv });
      if (resolved) {
        models = resolved.models;
        defaultModel = resolved.defaultModel;
      }
    }

    return {
      id: def.id,
      name: def.name,
      available,
      binary: result.binary,
      source: result.source,
      version: probeResult.version,
      probeError: probeResult.error ?? null,
      models,
      defaultModel,
      installUrl: def.installUrl,
      installable: !!def.install,
    };
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
      conversationId: run.conversationId,
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
      conversationId: run.conversationId,
    }));
  }

  /** Number of runs that have not yet reached a terminal state. */
  getActiveRunCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!TERMINAL_STATUSES.has(run.status)) count++;
    }
    return count;
  }

  onEvent(runId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.eventListeners.add(callback);
    dbgLog(`subscribe runId=${runId} listeners=${run.eventListeners.size}`);
    return () => {
      run.eventListeners.delete(callback);
      dbgLog(`unsubscribe runId=${runId} listeners=${run.eventListeners.size}`);
    };
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
    const args = def.buildArgs(
      opts.message,
      { model: opts.model },
      { cwd: opts.cwd },
    );

    const stdinMode = def.promptViaStdin || def.transport === 'acp-jsonrpc' ? 'pipe' : 'ignore';
    const isCmd = needsShellOnWindows(result.binary);
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

    if (def.transport === 'acp-jsonrpc') {
      // ── ACP path (Hermes, DeepSeek Harness) — pooled warm process ─────────
      // No per-run spawn: AcpPool keeps ONE process per agent (initialize runs
      // once); this run gets its own ACP session via initAcpPooled. New
      // conversations / retries / page reloads reuse the warm process instead
      // of paying the ~14s cold start. MOLIO_RUN_ID is deliberately NOT
      // injected — the process outlives any single run (and nothing consumes
      // the variable). ACP schema requires cwd to be absolute; resolve against
      // process.cwd() so a relative MOLIO_CWD env var doesn't silently break
      // session/new.
      const acpCwd = path.resolve(opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd());
      const acp = def.acp!;
      // Test escape hatch: env overrides for ACP handshake timeouts so
      // integration tests don't wait the full 60s idle / 30min absolute
      // defaults. Fallbacks match hermes.ts (idle 60s covers session/new's
      // silent availableModels network fetch on a cold start).
      const envIdle = Number(process.env.MOLIO_ACP_IDLE_TIMEOUT_MS);
      const idleTimeout = envIdle > 0 ? envIdle : (acp.idleTimeoutMs ?? 60000);
      const envAbsolute = Number(process.env.MOLIO_ACP_ABSOLUTE_TIMEOUT_MS);
      const absoluteTimeout = envAbsolute > 0 ? envAbsolute : (acp.absoluteTimeoutMs ?? 1800000);

      // ── Just-in-time [acp] extra auto-repair (Hermes only) ───────────────
      // Before spawning, probe `hermes-acp --check`. If the venv is missing
      // the [acp] extra (agent-client-protocol), auto-install it so the user
      // doesn't have to drop into a terminal. See runtimes/hermes.ts:
      // ensureAcpExtra for the full state machine.
      // Gated on def.acp.preflightRepair: the probe assumes `--check` is a
      // valid invocation, which is hermes-specific — dsh rejects unknown flags
      // with exit 1, so running the probe against it would fail pre-spawn.
      // Skipped when a warm process is already alive: repair only matters
      // pre-spawn, and every-run re-probing was the "why does it check the
      // install integrity before EVERY answer" complaint.
      if (acp.preflightRepair && !this.acpPool.hasLiveEntry(opts.agentId)) {
        try {
          await ensureAcpExtra(result.binary, {
            onProgress: (message) => {
              this.emitEvent(run, { type: 'repairing', message });
            },
          });
        } catch (err) {
          const message = err instanceof HermesRepairError
            ? formatAcpInitFailure(err, undefined, result.binary)
            : `ACP pre-spawn repair failed: ${err instanceof Error ? err.message : String(err)}`;
          this.emitEvent(run, { type: 'error', message });
          this.finishRun(run, 'failed', 1, null);
          return runId;
        }
      }

      const spec: AcpSpawnSpec = {
        agentId: opts.agentId,
        binary: result.binary,
        args: spawnArgs,
        env,
        cwd: acpCwd,
        shell: isCmd,
        fingerprint: this.buildAcpFingerprint(opts.agentId, result.binary, agentConfig),
        idleTimeoutMs: idleTimeout,
        absoluteTimeoutMs: absoluteTimeout,
      };

      this.initAcpPooled(run, def, spec, acpCwd, opts.model)
        .then(() => {
          // After init, drive the first session/prompt with the user's message.
          // Subsequent turns go through sendMessage. Terminal guard: the user
          // may have cancelled while init was in flight — sendMessage would
          // throw, and its error would land on an already-cancelled run.
          if (opts.message && run.acp?.sessionId && !TERMINAL_STATUSES.has(run.status)) {
            this.sendMessage(runId, opts.message);
          }
        })
        .catch((err) => {
          // The run was cancelled while init was in flight (user hit stop, or
          // shutdown fired cancelAll) — it's already terminal. Don't drop an
          // "ACP init failed" banner on top of an intentional cancellation
          // (same spirit as sendMessage's .catch guard for cancelled prompts).
          if (TERMINAL_STATUSES.has(run.status)) return;
          this.finishRun(run, 'failed', 1, null);
          // The pool decorates acquire/session-new failures with the entry's
          // last stderr line (the entry — and its stderr buffer — dies with
          // the failure, so snapshot it on the error).
          const lastStderr = (err as { acpLastStderrLine?: string }).acpLastStderrLine
            ?? run.lastStderrLine;
          this.emitEvent(run, { type: 'error', message: formatAcpInitFailure(err, lastStderr, run.binaryPath ?? spec.binary) });
        });

      return runId;
    }

    // ── stdio-jsonl path (Claude/Codex/Gemini/Qwen) — existing behavior ──
    // 1 run = 1 process, so the run id travels with the spawn env.
    env['MOLIO_RUN_ID'] = runId;

    const child: ChildProcess = spawn(result.binary, spawnArgs, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd(),
      // On Windows, .cmd/.bat shims and extensionless POSIX shims must be spawned
      // with shell: true — see launch.ts:needsShellOnWindows. Without it,
      // CreateProcess fails with EINVAL/ENOENT (D8 root cause).
      shell: isCmd,
      windowsVerbatimArguments: process.platform === 'win32' && !isCmd,
    });
    run.child = child;
    run.binaryPath = result.binary;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.emitEvent(run, { type: 'error', message: `stdin error: ${err.message}` });
    });

    child.stdout?.setEncoding('utf8');
    const stderrDecoder = createStderrDecoder();

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

      // The stream init event carries the Claude Code session id → start the
      // transcript watcher so background subagent/workflow activity surfaces
      // in the UI while the parent stream is silent. claude runtime only.
      if (ev.type === 'status' && ev.sessionId && def.id === 'claude' && !run.activityWatcher) {
        // Same cwd resolution as spawn() above — the transcript project dir is
        // derived from the directory Claude Code was launched in.
        const watchCwd = path.resolve(opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd());
        const watcher = new TranscriptWatcher(
          claudeProjectDir(watchCwd),
          `${ev.sessionId}.jsonl`,
          (activity) => this.emitEvent(run, { type: 'activity', activity }),
        );
        run.activityWatcher = watcher;
        watcher.start();
      }
    });

    child.stdout?.on('data', (chunk: string) => {
      parser.feed(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder ? stderrDecoder(chunk) : chunk.toString('utf8');
      // Classify the chunk: Codex info lines are dropped, Claude Code
      // `[claude-code:*]` diagnostics (e.g. unrecognized_model for any
      // third-party provider) become `raw` log events, everything else stays
      // an `error` event. See runtimes/stderr.ts for why.
      for (const event of classifyStderrChunk(def.id, text)) {
        this.emitEvent(run, event);
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
   * ACP initialization on the POOLED process — acquires (or spawns +
   * initializes) the agent's warm process from AcpPool, then creates this
   * run's own ACP session on it. Fire-and-forget from createRun so runId is
   * returned immediately; failures are decorated + rethrown for createRun's
   * catch to format. On success, sets run.acp (transport + sessionId +
   * poolEntryId), attaches the session sink, and pushes models to the frontend.
   *
   * `model` is the user-selected model id (undefined/'default' = agent's own
   * default). dsh applies it post-session/new via session/set_config_option;
   * hermes has no model-set RPC and ignores it.
   */
  private async initAcpPooled(
    run: RunState,
    def: RuntimeAgentDef,
    spec: AcpSpawnSpec,
    cwd: string,
    model?: string | null,
  ): Promise<void> {
    // acquire: reuse a live warm process (the fast path — no spawn, no
    // initialize, no ~14s cold start), or create a fresh one. Concurrent
    // acquires for the same agent share one spawn/initialize (pool dedups via
    // the entry's ready promise).
    let entry: PoolEntry;
    try {
      entry = await this.acpPool.acquire(spec);
    } catch (err) {
      // The pool decorates acquire failures with the dying entry's last stderr
      // line; snapshot it on the run as a fallback for createRun's error format.
      const decorated = (err as { acpLastStderrLine?: string }).acpLastStderrLine;
      if (decorated && !run.lastStderrLine) run.lastStderrLine = decorated;
      throw err;
    }

    const transport = entry.transport;
    // Assign run.acp early (sessionId filled in after session/new) so a
    // cancelRun landing mid-handshake can find the transport + pool entry.
    run.acp = { transport, sessionId: '', poolEntryId: entry.id };
    // Point run.child/binaryPath at the pooled process: canAcceptMessage's
    // stdin check and the `[binary: …]` error suffix read these. The pool owns
    // the child's lifecycle — RunManager must NEVER kill it directly (other
    // runs' sessions may be riding the same process).
    run.child = entry.child;
    run.binaryPath = spec.binary;

    // session/new — transport-level request (sent WITHOUT options.sessionId):
    // a process that can't create sessions is useless to every run, so a
    // timeout here goes through the pool's killChild hook and finalizes the
    // entry. Cheap on a warm process; per-run workspace isolation lives in the
    // cwd param (the process's OS-level cwd is just wherever the first
    // acquirer happened to be). ACP schema requires an absolute path.
    let session: any;
    try {
      session = await transport.request(
        'session/new',
        { mcpServers: [], cwd },
        { idleTimeoutMs: spec.idleTimeoutMs, absoluteTimeoutMs: spec.absoluteTimeoutMs },
      );
    } catch (err) {
      // Snapshot the entry-level stderr line for diagnostics — the entry may
      // already be finalized (and gone from the pool) by the time createRun's
      // catch formats the error message.
      if (entry.lastStderrLine) {
        run.lastStderrLine ??= entry.lastStderrLine;
        (err as Error & { acpLastStderrLine?: string }).acpLastStderrLine ??= entry.lastStderrLine;
      }
      // A JSON-RPC error leaves the entry alive with zero sessions — arm idle
      // eviction so the warm process doesn't linger until shutdown. (A timeout
      // already finalized the entry; arming is then a no-op.)
      this.acpPool.armIdleIfSessionless(entry.id);
      throw err;
    }
    const sessionId: string = session?.sessionId;
    if (!sessionId) {
      this.acpPool.armIdleIfSessionless(entry.id);
      throw new Error('session/new returned no sessionId');
    }
    run.acp.sessionId = sessionId;

    // The user may have hit stop (or shutdown fired cancelAll) while
    // session/new was in flight — the run is already terminal. Don't attach:
    // cancel the orphaned session best-effort (session-scoped, so even a
    // timeout can't kill the shared process) and bail before registering a
    // sink that would keep the entry's session map non-empty forever.
    if (TERMINAL_STATUSES.has(run.status)) {
      transport.request('session/cancel', { sessionId }, { absoluteTimeoutMs: 5000, sessionId })
        .catch(() => { /* orphan cleanup is best-effort */ });
      this.acpPool.armIdleIfSessionless(entry.id);
      return;
    }

    // Attach BEFORE any session/update for this session can arrive: routes
    // notifications to the run's event stream (the transport demuxes by
    // sessionId), replays buffered cold-start diagnostics into this run, and
    // registers the process-death callback that terminates the run.
    this.acpPool.attachSession(entry, sessionId, {
      sink: (ev) => {
        // Terminal guard: ignore late events after cancel/finish (detach
        // mostly prevents them, but finalizeEntry's broadcast can race a
        // concurrent finishRun).
        if (TERMINAL_STATUSES.has(run.status)) return;
        this.emitEvent(run, ev);
      },
      onProcessExit: (info) => {
        // The shared process died (crash / drain / transport-level timeout /
        // idle eviction). Pick this run's terminal status exactly like the old
        // per-run close handler did: cancelled session → canceled; a prompt in
        // flight or non-zero exit → failed; clean exit → succeeded.
        const status = info.wasCancelled
          ? 'canceled'
          : info.hadPendingPrompt || info.code !== 0
            ? 'failed'
            : 'succeeded';
        if (status === 'failed' && !run.error) {
          run.error = info.exitError.message;
        }
        this.finishRun(run, status, info.code, null);
      },
    });

    // Capture available models for the frontend. Two session/new shapes exist:
    //  - hermes: session.models.availableModels [{modelId, name}] + currentModelId
    //  - dsh: session.configOptions — a grouped select whose option `value` is
    //    a JSON-encoded [provider, model] tuple; switching goes through
    //    session/set_config_option (no session/set_model support).
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
    } else {
      const dshModels = parseConfigOptionsModels(session);
      if (dshModels) {
        let currentModelId = dshModels.currentSlug;
        if (model && model !== 'default') {
          const match = dshModels.entries.find((m) => m.id === model || m.label === model);
          if (!match) {
            // User-preference rule: never silently fall back to another model.
            // Surface the mismatch and fail the run so the user can pick a
            // valid model.
            throw new Error(
              `Model "${model}" is not available in ${def.name}. Available: `
              + dshModels.entries.map((m) => m.id).join(', '),
            );
          }
          // Session-scoped (sessionId in options): a set_config_option timeout
          // must not kill the shared process other conversations are riding.
          await transport.request(
            'session/set_config_option',
            { sessionId, configId: 'model', value: match.value },
            { idleTimeoutMs: spec.idleTimeoutMs, absoluteTimeoutMs: spec.absoluteTimeoutMs, sessionId },
          );
          currentModelId = match.id;
        }
        run.acpModels = dshModels.entries.map((m) => ({ modelId: m.id, name: m.label }));
        this.emitEvent(run, {
          type: 'models',
          models: dshModels.entries.map((m) => ({ id: m.id, label: m.label })),
          currentModelId,
        });
      }
    }

    // Session is live — stdin stays open for multi-turn follow-ups via
    // sendMessage. Without this, canAcceptMessage would always return false
    // for ACP runs (it checks stdinOpen), blocking WeixinService's session
    // reuse path even on healthy long-running hermes processes.
    run.stdinOpen = true;
    this.emitEvent(run, { type: 'status', label: 'running' });
  }

  /**
   * Config fingerprint for a pooled ACP process. acquire() compares it against
   * the live entry's fingerprint — a mismatch (provider config changed, binary
   * moved, env edited) drains the old process and respawns, so stale
   * credentials never survive into the next message. Also covers hand-edits to
   * hermes' config.yaml/.env, which don't go through Molio's PUT /provider
   * route and therefore can't trigger its explicit drain hook.
   */
  private buildAcpFingerprint(
    agentId: string,
    binary: string,
    agentConfig: AgentConfig,
  ): string {
    const hash = createHash('sha256');
    hash.update(binary);
    hash.update('\0');
    hash.update(agentConfig.binaryPath ?? '');
    hash.update('\0');
    // Stable env subset: keys sorted so property order can't churn the
    // fingerprint. Per-run volatile env (MOLIO_RUN_ID etc.) is no longer
    // injected into ACP spawns, so everything here is config, not noise.
    const envEntries = Object.entries(agentConfig.env ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    hash.update(JSON.stringify(envEntries));
    if (agentId === 'hermes') {
      // Hash hermes' native config files: PUT /provider writes them, and users
      // may hand-edit them — either way a live process started with the old
      // contents must be recycled.
      try {
        const home = resolveHermesHome();
        for (const file of ['config.yaml', '.env']) {
          hash.update('\0');
          try {
            hash.update(readFileSync(path.join(home, file)));
          } catch {
            hash.update('missing');
          }
        }
      } catch {
        hash.update('\0no-home');
      }
    }
    return hash.digest('hex');
  }

  /**
   * Drain an agent's pooled ACP process — called by PUT /:agentId/provider
   * after writing new provider config, so the next message spawns a fresh
   * process with the new credentials instead of riding the warm one.
   * (acquire()'s fingerprint check is the fallback for config changes that
   * don't go through the route.)
   */
  drainAcpPool(agentId: string): void {
    this.acpPool.drain(agentId, 'provider-config-changed');
  }

  /** Test seam: the ACP process pool (integration tests assert reuse/drain). */
  __getAcpPool(): AcpPool {
    return this.acpPool;
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
    // ACP runs additionally require a live session on a LIVE pooled process —
    // the shared process may have crashed, been drained (provider config
    // change), or been idle-evicted since this run's last turn, and its stdin
    // can look writable while the internal session is dead. Without this
    // check, sendMessage would fire session/prompt at a stale sessionId and
    // the user wouldn't learn it's broken until the idle timeout 5min later.
    if (def.transport === 'acp-jsonrpc') {
      if (!run.acp?.sessionId) return false;
      if (!this.acpPool.isEntryAlive(run.acp.poolEntryId)) return false;
    }
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
      const { transport, sessionId, poolEntryId } = run.acp;
      // initAcpPooled sets sessionId='' before session/new resolves; if
      // session/new failed, run.acp exists but sessionId is empty. Guard
      // against sending a malformed session/prompt with an empty sessionId.
      if (!sessionId) throw new Error('ACP session not initialized — sessionId is empty');
      const acp = def.acp!;
      // Prompt phase uses a longer idle timeout than handshake — hermes goes
      // silent while waiting for the LLM to respond (compiling system prompt,
      // loading tool defs, first-token latency). Fallbacks match hermes.ts
      // defaults (promptIdle 5min / absolute 30min) — the previous `|| 60000`
      // fallback was a stale 1min value that tripped on any real workflow.
      // `> 0` check preserves an explicit 0 from env (not that anyone would
      // want 0, but `||` would coerce it to the fallback and hide intent).
      const envPromptIdle = Number(process.env.MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS);
      const promptIdle = envPromptIdle > 0
        ? envPromptIdle
        : (acp.promptIdleTimeoutMs ?? 300000);
      const envAbsolute = Number(process.env.MOLIO_ACP_ABSOLUTE_TIMEOUT_MS);
      const absoluteTimeout = envAbsolute > 0
        ? envAbsolute
        : (acp.absoluteTimeoutMs ?? 1800000);
      // Fire-and-forget: events flow in via session/update notifications during the await;
      // turn_end is emitted when the prompt response arrives.
      // Session-scoped (sessionId in options): a hung prompt times out THIS
      // run only — the shared process survives for the other conversations.
      transport.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: message }] },
        { idleTimeoutMs: promptIdle, absoluteTimeoutMs: absoluteTimeout, sessionId },
      )
        .then((resp: any) => {
          // The run may have been cancelled (or the process drained → run
          // failed via onProcessExit) while the prompt was in flight — don't
          // emit a late turn_end that would resurrect the UI's streaming state
          // or trigger onTurnComplete on a terminal run.
          if (TERMINAL_STATUSES.has(run.status)) return;
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
          // cancelRun sets run.status='canceled' synchronously, then the pool's
          // finalizeEntry rejectAll rejects this prompt. By the time .catch
          // runs, rejectAll has already cleared cancelledSessionIds (so
          // isCancelled above returns false even for a cancelled session).
          // Guard on terminal status to suppress the spurious "prompt failed:
          // hermes-acp process exited" error event for runs the user already
          // cancelled or that onProcessExit already terminated.
          if (TERMINAL_STATUSES.has(run.status)) return;
          // Append the last stderr line hermes printed before going silent —
          // when idle/absolute timeout fires, the error alone gives reporters
          // no clue what hermes was doing. The last stderr line is usually
          // "connecting to provider X" or similar, which is the actual cause.
          // Pool-level now: stderr belongs to the shared process, so read it
          // from the entry (run.lastStderrLine is only set on init failures).
          // Also include the binary path so users can spot "wrong install" cases.
          const stderrLine = this.acpPool.getLastStderrLine(poolEntryId) ?? run.lastStderrLine;
          const lastStderr = stderrLine ? ` (last stderr: "${stderrLine}")` : '';
          const binarySuffix = run.binaryPath ? ` [binary: ${run.binaryPath}]` : '';
          // Agents report config problems in their own vocabulary (e.g. dsh's
          // "store DEEPSEEK_API_KEY through the credentials service" — a
          // concept Molio's UI doesn't have). Append a Molio-actionable hint
          // when the message matches a known pattern; original text stays for
          // diagnostics.
          const hint = agentErrorHint(run.agentId, err.message);
          const hintSuffix = hint ? ` | Molio 提示：${hint}` : '';
          this.emitEvent(run, { type: 'error', message: `prompt failed: ${err.message}${lastStderr}${binarySuffix}${hintSuffix}` });
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

  /**
   * Cancel a run and kill its child process.
   *
   * `reason` is a short caller tag (`api:delete-run`, `shutdown:graceful`, …)
   * that is logged — a cancel is destructive and previously left no trace at
   * all, so a run that died mid-reply could not be attributed to a caller
   * after the fact (2026-09-28 investigation: two unexplained cancellations,
   * no way to tell whether a user hit 停止 or something cancelled on its own).
   * Add a reason whenever you add a caller.
   */
  cancelRun(runId: string, reason = 'unspecified'): void {
    const run = this.runs.get(runId);
    if (!run) {
      console.log(`[runs] cancel ignored run=${runId} reason=${reason} (unknown run)`);
      return;
    }
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
    console.log(
      `[runs] cancel run=${runId} reason=${reason} agent=${run.agentId}`
        + ` status=${run.status}${wasTerminal ? ' (already terminal — no-op)' : ''}`,
    );
    if (!wasTerminal) {
      run.status = 'canceled';
      run.stdinOpen = false;
      run.updatedAt = Date.now();
    }

    // Flush any accumulated text before killing the process.
    run.turnText.flush();

    if (def?.transport === 'acp-jsonrpc' && run.acp) {
      const { transport, sessionId, poolEntryId } = run.acp;
      transport.markCancelled(sessionId);
      const cancelTimeout = def.acp?.cancelTimeoutMs ?? 5000;
      // Cancel is a short ack — strict absolute deadline, no idle timer.
      // Session-scoped (sessionId in options): even a cancel timeout must not
      // kill the shared process other conversations are riding. Fire-and-forget
      // — the detach below is what actually frees this run.
      if (sessionId) {
        transport.request('session/cancel', { sessionId }, { absoluteTimeoutMs: cancelTimeout, sessionId })
          .catch(() => { /* cancel ack failed — session is detached anyway */ });
      }
      // Detach NOW (before any late session/update races in): stops routing
      // events to this run and — when it was the entry's last session — arms
      // the pool's idle-eviction timer. The process itself SURVIVES: that's
      // the point of the pool (next conversation/retry/reload reuses it
      // instead of paying the cold start).
      this.acpPool.detachSession(poolEntryId, sessionId);
      // Mirror the non-ACP tail: emit the canceled status so SSE listeners
      // close cleanly, and close the JSONL log. finishRun can't do this — it
      // early-returns on the 'canceled' status set synchronously above.
      if (!wasTerminal) {
        this.emitEvent(run, { type: 'status', label: 'canceled' });
        try { run.eventsLogStream?.end(); } catch { /* ignore */ }
        run.eventsLogStream = null;
      }
      return;
    }

    // Tree-kill on Windows (reap the cmd.exe wrapper's agent grandchild);
    // SIGTERM→SIGKILL on POSIX. See runtimes/kill-tree.ts.
    killAgentProcessTree(run.child);
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

  cancelAll(reason = 'unspecified'): void {
    for (const [id] of this.runs) {
      this.cancelRun(id, reason);
    }
    // Drain pooled ACP processes: cancelAll runs on daemon shutdown (SIGINT,
    // graceful close, desktop shutdown request) and in test cleanup — warm
    // hermes/dsh processes must not outlive their owner. cancelRun alone only
    // detaches sessions and deliberately keeps the shared process alive.
    this.acpPool.drainAll(`cancelAll:${reason}`);
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

    // Accumulate tool events for turn-complete persistence (use/result pairs →
    // assembled ToolEvents; see TurnTextCollector.addToolUse/addToolResult).
    if (event.type === 'tool_use') {
      run.turnText.addToolUse(event);
    }
    if (event.type === 'tool_result') {
      run.turnText.addToolResult(event);
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
    const listeners = run.eventListeners.size;
    if (listeners === 0) {
      // Diagnostic: an event was emitted but no SSE stream is subscribed. If this
      // happens mid-run (not terminal cleanup), it's the smoking gun for assumption 3
      // — the SSE listener was cleaned up (e.g. spurious abort) while the run is still
      // active, so the frontend never receives this event. This is on the per-event
      // hot path, so throttle per runId — a run that lost its subscriber would
      // otherwise log this for every remaining event (throttled-warn.ts).
      this.noSubscriberWarn.warn(
        run.id,
        `emit listeners=0 (NO SSE SUBSCRIBER) runId=${run.id} type=${event.type} status=${run.status}`,
      );
    }
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

    // Detach the ACP session from the pooled process (idempotent — cancelRun
    // may have detached already). Arms the pool's idle-eviction timer when
    // this was the entry's last session; the process itself survives for the
    // other runs riding it.
    if (run.acp?.poolEntryId && run.acp.sessionId) {
      this.acpPool.detachSession(run.acp.poolEntryId, run.acp.sessionId);
    }

    // Stop subagent activity tracking; emit a final snapshot so the UI can
    // flip running workers to their terminal state.
    if (run.activityWatcher) {
      const final = run.activityWatcher.finalize();
      run.activityWatcher.stop();
      run.activityWatcher = undefined;
      if (final.agents.length > 0) {
        this.emitEvent(run, { type: 'activity', activity: final });
      }
    }

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
        // Drop this run's throttle state too — noSubscriberWarn is keyed by
        // run.id (a UUID), so without this its state map grows unbounded over
        // the daemon's lifetime (one entry per run that lost its subscriber).
        this.noSubscriberWarn.delete(run.id);
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
