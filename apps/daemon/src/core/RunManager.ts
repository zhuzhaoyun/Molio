import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent, AgentInfo, RuntimeAgentDef, RunInfo, RunStatus,
} from '@kge/contracts';
import { getAgentDef, listAgentDefs } from './runtimes/registry.js';
import { resolveAgentBinary, probeVersion } from './runtimes/launch.js';
import { buildSpawnEnv } from './runtimes/env.js';
import { createClaudeStreamHandler } from './streams/claude-stream.js';
import { createCodexStreamHandler } from './streams/codex-stream.js';
import type { StreamHandler } from '@kge/contracts';
import { createJsonlParser } from './streams/jsonl-parser.js';
import { loadConfig, getAgentConfig, buildAgentEnv } from './config.js';
import type { RunState } from '../types.js';

export interface CreateRunOptions {
  agentId: string;
  message: string;
  model?: string;
  cwd?: string;
}

export class RunManager {
  private runs = new Map<string, RunState>();

  detectAgents(): AgentInfo[] {
    const config = loadConfig();
    return listAgentDefs().map((def) => {
      const agentConfig = config.agents[def.id] || {};
      const configuredEnv = agentConfig.env || {};
      const result = resolveAgentBinary(def, { configuredEnv });
      const version = result.binary ? probeVersion(result.binary, def.versionArgs) : null;
      return {
        id: def.id,
        name: def.name,
        available: result.binary !== null,
        binary: result.binary,
        source: result.source,
        version,
        models: def.fallbackModels,
        installUrl: def.installUrl,
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
    };
  }

  listRuns(): RunInfo[] {
    return Array.from(this.runs.values()).map((run) => ({
      id: run.id,
      agentId: run.agentId,
      status: run.status,
      createdAt: run.createdAt,
      lastStopReason: run.lastStopReason,
    }));
  }

  onEvent(runId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.eventListeners.add(callback);
    return () => { run.eventListeners.delete(callback); };
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

    const mergedEnv = buildAgentEnv(opts.agentId, agentConfig);
    const env = buildSpawnEnv(def, mergedEnv);

    const args = def.buildArgs(
      opts.message,
      { model: opts.model },
      { cwd: opts.cwd },
    );

    const stdinMode = def.promptViaStdin ? 'pipe' : 'ignore';
    const child: ChildProcess = spawn(result.binary, args, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: opts.cwd || agentConfig.env?.['KGE_CWD'] || process.cwd(),
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    run.child = child;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.emitEvent(run, { type: 'error', message: `stdin error: ${err.message}` });
    });

    if (def.promptViaStdin && child.stdin) {
      if (def.promptInputFormat === 'stream-json') {
        const msg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: opts.message },
        });
        child.stdin.write(msg + '\n', 'utf8');
        run.stdinOpen = true;
      } else {
        child.stdin.end(opts.message);
        run.stdinOpen = false;
      }
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

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

    child.stderr?.on('data', (chunk: string) => {
      this.emitEvent(run, { type: 'raw', line: `[stderr] ${chunk}` });
    });

    child.on('error', (err) => {
      run.status = 'failed';
      this.emitEvent(run, { type: 'error', message: `Spawn error: ${err.message}` });
    });

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
      run.status = 'canceled';
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
    return createJsonlParser((line: string) => {
      onEvent({ type: 'raw', line });
    });
  }
}
