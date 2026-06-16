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
import type { StreamHandler } from '@molio/contracts';
import { createJsonlParser } from './streams/jsonl-parser.js';
import { loadConfig, getAgentConfig, buildAgentEnv } from './config.js';
import { buildTranscript, type TranscriptMessage } from './transcript.js';
import type { RunState, BufferedEvent } from '../types.js';

const TERMINAL_STATUSES = new Set<RunStatus>(['succeeded', 'failed', 'canceled']);
const MAX_EVENTS = 2_000;
const RUN_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
      const version = result.binary ? probeVersion(result.binary, def.versionArgs) : null;
      // Agent is only "available" if we can both find the binary AND
      // successfully probe its version. A .cmd shim created by npm always
      // exists even when the postinstall failed (leaving a placeholder).
      // probeVersion returns null when the binary can't actually execute.
      const available = result.binary !== null && version !== null;
      return {
        id: def.id,
        name: def.name,
        available,
        binary: result.binary,
        source: result.source,
        version,
        models: def.fallbackModels,
        installUrl: def.installUrl,
        installable: def.installable,
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
    };
    this.runs.set(runId, run);

    const mergedEnv = buildAgentEnv(opts.agentId, agentConfig);
    const env = buildSpawnEnv(def, mergedEnv);
    env['MOLIO_RUN_ID'] = runId;

    const args = def.buildArgs(
      opts.message,
      { model: opts.model },
      { cwd: opts.cwd },
    );

    const stdinMode = def.promptViaStdin ? 'pipe' : 'ignore';
    const isWin = process.platform === 'win32';
    const isCmd = isWin && (result.binary.endsWith('.cmd') || result.binary.endsWith('.bat'));

    const child: ChildProcess = spawn(result.binary, args, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd(),
      // On Windows, .cmd/.bat files must be spawned with shell: true to avoid EINVAL
      shell: isCmd,
      windowsVerbatimArguments: isWin && !isCmd,
    });
    run.child = child;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.emitEvent(run, { type: 'error', message: `stdin error: ${err.message}` });
    });

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

    child.stdout?.setEncoding('utf8');
    // On Windows with non-UTF-8 console code page (e.g. CP936/GBK for Chinese),
    // stderr from cmd.exe and child processes is in the system code page, not UTF-8.
    // Use a TextDecoder-based decoder to avoid mojibake in error messages.
    const stderrDecoder = createStderrDecoder();

    const parser = this.selectParser(def, (ev) => {
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

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = stderrDecoder
        ? stderrDecoder(chunk as Buffer)
        : (chunk as string);
      const trimmed = text.trim();
      if (trimmed) {
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
   * Send a follow-up user message to an active run (multi-turn).
   * Writes to the existing stdin stream for stream-json agents.
   */
  sendMessage(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
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
