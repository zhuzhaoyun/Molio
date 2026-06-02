import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentInfo, RunState, RuntimeAgentDef } from './types.js';
import { getAgentDef, listAgentDefs } from './runtimes/registry.js';
import { resolveAgentBinary, probeVersion } from './runtimes/launch.js';
import { buildSpawnEnv } from './runtimes/env.js';
import { createClaudeStreamHandler } from './streams/claude-stream.js';
import { createCodexStreamHandler } from './streams/codex-stream.js';
import type { StreamHandler } from './types.js';
import { createJsonlParser } from './streams/jsonl-parser.js';

export interface CreateRunOptions {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
}

export class RunManager {
  private runs = new Map<string, RunState>();

  /**
   * List available agents with version info.
   */
  listAgents(): AgentInfo[] {
    return listAgentDefs().map((def) => {
      const bin = resolveAgentBinary(def);
      const version = bin ? probeVersion(bin, def.versionArgs) : null;
      return {
        id: def.id,
        name: def.name,
        available: bin !== null,
        version,
        models: def.fallbackModels,
        installUrl: def.installUrl,
      };
    });
  }

  /**
   * Subscribe to events for a specific run.
   * Returns an unsubscribe function.
   */
  onEvent(runId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.eventListeners.add(callback);
    return () => { run.eventListeners.delete(callback); };
  }

  /**
   * Create a new run: spawn CLI process, wire up parsing and event dispatch.
   */
  async createRun(opts: CreateRunOptions): Promise<string> {
    // ── Step 1: Look up definition ──
    const def = getAgentDef(opts.agentId);
    if (!def) throw new Error(`Unknown agent: ${opts.agentId}`);

    // ── Step 2: Resolve binary ──
    const bin = resolveAgentBinary(def);
    if (!bin) {
      throw new Error(
        `Binary not found for ${def.name}. Install it or set ${def.id.toUpperCase()}_BIN env var.`
        + (def.installUrl ? `\nInstall: ${def.installUrl}` : ''),
      );
    }

    // ── Step 3: Create run state ──
    const runId = randomUUID();
    const run: RunState = {
      id: runId,
      agentId: opts.agentId,
      status: 'running',
      child: null,
      stdinOpen: false,
      pendingHostAnswers: new Set(),
      lastStopReason: null,
      eventListeners: new Set(),
      createdAt: Date.now(),
    };
    this.runs.set(runId, run);

    // ── Step 4: Build environment ──
    const env = buildSpawnEnv(def);

    // ── Step 5: Build arguments ──
    const args = def.buildArgs(
      opts.message,
      { model: opts.model },
      { cwd: opts.cwd },
    );

    // ── Step 6: Spawn ──
    const stdinMode = def.promptViaStdin ? 'pipe' : 'ignore';
    const child: ChildProcess = spawn(bin, args, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: opts.cwd || process.cwd(),
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    run.child = child;

    // ── Step 7: Wire stdin EPIPE handler ──
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.emitEvent(run, { type: 'error', message: `stdin error: ${err.message}` });
    });

    // ── Step 8: Deliver prompt ──
    if (def.promptViaStdin && child.stdin) {
      if (def.promptInputFormat === 'stream-json') {
        // JSONL: write one line, keep stdin OPEN for later tool_result injection
        const msg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: opts.message },
        });
        child.stdin.write(msg + '\n', 'utf8');
        run.stdinOpen = true;
      } else {
        // Plain text: write and close
        child.stdin.end(opts.message);
        run.stdinOpen = false;
      }
    }

    // ── Step 9: Set stdout/stderr encoding ──
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    // ── Step 10: Select parser ──
    const parser = this.selectParser(def, (ev) => {
      this.emitEvent(run, ev);

      // Track pending host answers for AskUserQuestion
      if (run.stdinOpen && ev.type === 'tool_use' && ev.name === 'AskUserQuestion') {
        run.pendingHostAnswers.add(ev.id);
      }

      // Track stop reason and maybe close stdin
      if (ev.type === 'turn_end') {
        run.lastStopReason = ev.stopReason;
        this.maybeCloseStdin(run);
      }

      // Also close stdin on usage (end of conversation)
      if (ev.type === 'usage') {
        this.maybeCloseStdin(run);
      }
    });

    // ── Step 11: Wire stdout ──
    child.stdout?.on('data', (chunk: string) => {
      parser.feed(chunk);
    });

    // ── Step 12: Wire stderr ──
    child.stderr?.on('data', (chunk: string) => {
      this.emitEvent(run, { type: 'raw', line: `[stderr] ${chunk}` });
    });

    // ── Step 13: Wire error ──
    child.on('error', (err) => {
      run.status = 'failed';
      this.emitEvent(run, { type: 'error', message: `Spawn error: ${err.message}` });
    });

    // ── Step 14: Wire close ──
    child.on('close', (code) => {
      parser.flush();
      run.status = code === 0 ? 'succeeded' : 'failed';
      run.stdinOpen = false;
      this.emitEvent(run, {
        type: 'status',
        label: code === 0 ? 'completed' : 'failed',
      });
    });

    return runId;
  }

  /**
   * Inject a tool_result into the running CLI's stdin (for AskUserQuestion).
   */
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

  /**
   * Cancel a running agent.
   */
  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.child && !run.child.killed) {
      run.status = 'canceled';
      run.child.kill('SIGTERM');
      // Force kill after 5s
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

  /**
   * Cancel all active runs (called on app shutdown).
   */
  cancelAll(): void {
    for (const [id] of this.runs) {
      this.cancelRun(id);
    }
  }

  // ── Private helpers ──

  private emitEvent(run: RunState, event: AgentEvent): void {
    for (const listener of run.eventListeners) {
      try { listener(event); } catch { /* listener error, skip */ }
    }
  }

  private maybeCloseStdin(run: RunState): void {
    if (run.pendingHostAnswers.size > 0) return;
    if (run.lastStopReason === 'tool_use') return;
    if (run.child?.stdin?.writable && run.stdinOpen) {
      try { run.child.stdin.end(); } catch { /* ignore */ }
      run.stdinOpen = false;
    }
  }

  private selectParser(
    def: RuntimeAgentDef,
    onEvent: (ev: AgentEvent) => void,
  ): StreamHandler {
    if (def.streamFormat === 'claude-stream-json') {
      return createClaudeStreamHandler(onEvent);
    }
    if (def.streamFormat === 'json-event-stream') {
      if (def.eventParser === 'codex') {
        return createCodexStreamHandler(onEvent);
      }
    }
    // Fallback: raw passthrough
    return createJsonlParser((line: string) => {
      onEvent({ type: 'raw', line });
    });
  }
}
