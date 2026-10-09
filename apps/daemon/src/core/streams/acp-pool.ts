import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentEvent } from '@molio/contracts';
import { AcpTransport } from './acp-transport.js';
import { killAgentProcessTree } from '../runtimes/kill-tree.js';
import { createStderrDecoder } from '../runtimes/env.js';

/**
 * AcpPool — shared warm-process pool for ACP agents (hermes, dsh).
 *
 * Before this pool, 1 Molio run = 1 spawned process = 1 ACP session: every
 * new conversation / retry / page reload paid the full ~14s cold start
 * (python interpreter + venv + pm.activate/drift integrity check + model
 * enumeration + ACP handshake) before the first token. The pool keeps ONE
 * warm process per agentId and gives each run its own ACP session — hermes
 * natively supports multiple sessions per process (`_sessions` dict,
 * per-session cancel; verified in the installed source).
 *
 * Ownership split:
 *  - Pool: process lifecycle (spawn, initialize, crash handling, idle
 *    eviction, drain), stderr classification, per-session sink routing.
 *  - RunManager: session lifecycle (session/new, prompt, cancel) and run
 *    status bookkeeping via the attachSession callbacks.
 *
 * Timeout blast radius: transport-level requests (initialize, session/new —
 * sent WITHOUT options.sessionId) time out → killChild → pool finalizes the
 * entry and fails every attached run. Session-scoped requests (session/prompt
 * etc., sent WITH options.sessionId) time out → only that request rejects;
 * the shared process survives for the other conversations.
 */

/** Everything needed to spawn + initialize a pooled ACP process. */
export interface AcpSpawnSpec {
  agentId: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * Working directory for the spawned process. Per-session cwd travels in
   * session/new params — this is only the OS-level cwd for the process itself
   * (the first acquirer's cwd; harmless because ACP agents resolve session
   * workspaces from session/new, not from process.cwd()).
   */
  cwd: string;
  /** Windows .cmd/.bat shims need shell:true (see launch.ts:needsShellOnWindows). */
  shell: boolean;
  /**
   * Config fingerprint — when acquire() sees a live entry with a different
   * fingerprint (provider config changed, binary path moved, env edited), the
   * old entry is drained and a fresh process is spawned with the new config.
   */
  fingerprint: string;
  /** ACP idle timeout for the initialize handshake (env-overridable by caller). */
  idleTimeoutMs: number;
  /** ACP absolute timeout cap for the initialize handshake. */
  absoluteTimeoutMs: number;
}

/** Per-session callbacks supplied by the attaching RunManager run. */
export interface AcpSessionAttachment {
  /** Event sink — receives session-scoped updates + broadcast transport events. */
  sink: (ev: AgentEvent) => void;
  /**
   * Called when the process dies (crash, drain, transport-level timeout) with
   * a pre-computed snapshot so the run can pick its terminal status. Fires
   * BEFORE pending request rejections settle? No — rejectAll has already run;
   * the pending prompt Promise rejected with `exitError`. Order: this
   * callback first, then the run's .catch sees a terminal status.
   */
  onProcessExit: (info: {
    code: number | null;
    wasCancelled: boolean;
    hadPendingPrompt: boolean;
    exitError: Error;
  }) => void;
}

export interface PoolEntry {
  id: string;
  agentId: string;
  child: ChildProcess;
  transport: AcpTransport;
  /** Resolves once initialize succeeded; rejects (after cleanup) otherwise. */
  ready: Promise<void>;
  alive: boolean;
  fingerprint: string;
  binary: string;
  /** sessionId → attachment. Empty + idle TTL armed → process gets evicted. */
  sessions: Map<string, AcpSessionAttachment>;
  /** Last non-empty stderr line (entry-level — survives individual runs). */
  lastStderrLine?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * Events emitted before the first session attaches (stderr during
   * initialize, transport diagnostics). Buffered (capped) and replayed to the
   * first attaching session so run #1's events.jsonl keeps the cold-start
   * diagnostics it had in the 1-run-1-process world.
   */
  earlyEvents: AgentEvent[];
}

export interface AcpPoolHooks {
  /**
   * Broadcast hook — the pool has no direct access to RunManager internals.
   * Currently unused by the pool itself (broadcasts go through session sinks),
   * kept as an extension seam.
   */
  onEntryDrained?: (agentId: string, entryId: string, reason: string) => void;
}

let entryCounter = 0;

const EARLY_EVENTS_CAP = 500;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000; // 10 min with zero sessions

/**
 * Classify one trimmed ACP stderr line into an AgentEvent (exported pure
 * function — moved out of RunManager.handleAcpStderr so the pool, which owns
 * the stderr stream now, can reuse the exact same rules).
 *
 *  - dsh (Node): only explicit error headers become `error` events; warnings,
 *    plugin-activation detail lines, ExperimentalWarnings stay log-only `raw`
 *    (an `error` event flips the frontend to streaming:false and swallows the
 *    reply stream — ACP-level failures arrive via JSON-RPC error responses).
 *  - hermes (python): `YYYY-MM-DD HH:MM:SS [INFO|WARNING|DEBUG] …` log lines
 *    stay `raw` (persisted to events.jsonl for diagnosis); ERROR lines and
 *    Python tracebacks surface as `error`.
 */
export function classifyAcpStderrLine(agentId: string, line: string): AgentEvent {
  if (agentId === 'dsh') {
    const isExplicitError = /^dsh:\s*error\b/i.test(line) || /^Error:/i.test(line);
    return isExplicitError
      ? { type: 'error', message: line }
      : { type: 'raw', line };
  }
  const isInfoLevel = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[(INFO|WARNING|DEBUG)\]/;
  return isInfoLevel.test(line)
    ? { type: 'raw', line }
    : { type: 'error', message: line };
}

export class AcpPool {
  /** agentId → single warm entry (one process per agent is enough for a desktop app). */
  private entries = new Map<string, PoolEntry>();
  private readonly idleTtlMs: number;

  constructor(private readonly hooks: AcpPoolHooks = {}) {
    const envTtl = Number(process.env.MOLIO_ACP_POOL_IDLE_MS);
    this.idleTtlMs = Number.isFinite(envTtl) && envTtl !== 0
      ? envTtl
      : DEFAULT_IDLE_TTL_MS;
  }

  /**
   * Get (or spawn + initialize) the warm process for an agent.
   *
   *  - live entry with matching fingerprint → returned immediately (the fast
   *    path that makes new conversations/retries/reloads skip the cold start);
   *  - live entry with a DIFFERENT fingerprint → drained (old runs failed) and
   *    respawned — this is the belt to the PUT /provider route's explicit
   *    drain() braces: even a hand-edited config.yaml gets picked up;
   *  - in-flight spawn → callers share the same `ready` promise (no stampede
   *    when two conversations start at once);
   *  - initialize failure → entry finalized (process killed, attached runs
   *    failed) and the error rethrown, decorated with `acpLastStderrLine` so
   *    the caller can build the same diagnostic the old 1:1 path had.
   */
  async acquire(spec: AcpSpawnSpec): Promise<PoolEntry> {
    const existing = this.entries.get(spec.agentId);
    if (existing) {
      if (existing.alive && existing.fingerprint === spec.fingerprint) {
        this.disarmIdleTimer(existing);
        return existing;
      }
      // Dead entry, or config changed under our feet — tear down, respawn.
      this.removeEntry(existing);
      if (existing.alive) {
        this.finalizeEntry(existing, null, new Error(
          `ACP process recycled: ${spec.agentId} configuration changed`,
        ));
        killAgentProcessTree(existing.child);
      }
    }

    const entry = this.spawnEntry(spec);
    this.entries.set(spec.agentId, entry);
    try {
      await entry.ready;
    } catch (err) {
      // spawnEntry's ready-catch already finalized + killed; make sure the map
      // doesn't keep pointing at the dead entry.
      this.removeEntry(entry);
      throw err;
    }
    this.disarmIdleTimer(entry);
    return entry;
  }

  /**
   * Attach a run's session to a live entry: routes session/update events to
   * `sink`, replays buffered early events, and registers the onProcessExit
   * callback. Clears the idle-eviction timer while any session is attached.
   */
  attachSession(entry: PoolEntry, sessionId: string, att: AcpSessionAttachment): void {
    entry.sessions.set(sessionId, att);
    this.disarmIdleTimer(entry);
    entry.transport.registerSession(sessionId, att.sink);
    // Replay cold-start diagnostics (stderr during initialize etc.) into the
    // first session so its events.jsonl matches the pre-pool behavior.
    if (entry.earlyEvents.length > 0) {
      const pending = entry.earlyEvents;
      entry.earlyEvents = [];
      for (const ev of pending) {
        try { att.sink(ev); } catch { /* sink error must not break replay */ }
      }
    }
  }

  /**
   * Detach a session (run finished/cancelled). Idempotent — cancelRun and
   * finishRun may both call it. Arms the idle-eviction timer when the entry
   * has no sessions left.
   */
  detachSession(entryId: string, sessionId: string): void {
    const entry = this.findEntryById(entryId);
    if (!entry) return;
    if (!entry.sessions.delete(sessionId)) {
      // Still unregister the sink (transport map is the routing authority).
      entry.transport.unregisterSession(sessionId);
      return;
    }
    entry.transport.unregisterSession(sessionId);
    if (entry.sessions.size === 0 && entry.alive) {
      this.armIdleTimer(entry);
    }
  }

  /**
   * Re-arm idle eviction for an entry that ended up with zero sessions
   * WITHOUT going through detachSession — e.g. the attacher bailed after a
   * successful acquire (run cancelled mid-handshake, session/new answered
   * with a JSON-RPC error). Without this the warm process would sit
   * session-less and timer-less until the next acquire or shutdown.
   * No-op when the entry is gone, dead, or still has sessions.
   */
  armIdleIfSessionless(entryId: string): void {
    const entry = this.findEntryById(entryId);
    if (!entry || !entry.alive || entry.sessions.size > 0) return;
    this.armIdleTimer(entry);
  }

  /** Drain (kill) an agent's pooled process — e.g. after provider config changes. */
  drain(agentId: string, reason = 'drain'): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    this.removeEntry(entry);
    if (entry.alive) {
      this.finalizeEntry(entry, null, new Error(`ACP process drained: ${reason}`));
      killAgentProcessTree(entry.child);
    }
  }

  /** Drain every pooled process (daemon shutdown / cancelAll). */
  drainAll(reason = 'shutdown'): void {
    for (const agentId of [...this.entries.keys()]) {
      this.drain(agentId, reason);
    }
  }

  /** Is the entry still alive? (canAcceptMessage checks this before prompting.) */
  isEntryAlive(entryId: string): boolean {
    const entry = this.findEntryById(entryId);
    return !!entry && entry.alive;
  }

  /** Entry-level last stderr line — for error messages after the run detached. */
  getLastStderrLine(entryId: string): string | undefined {
    return this.findEntryById(entryId)?.lastStderrLine;
  }

  /** Does this agent have a live warm process? (preflight-repair skip check.) */
  hasLiveEntry(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    return !!entry && entry.alive;
  }

  /** Test seam: current entry for an agent (undefined if none/dead-removed). */
  __getEntry(agentId: string): PoolEntry | undefined {
    return this.entries.get(agentId);
  }

  /** Test seam: number of pooled entries. */
  __size(): number {
    return this.entries.size;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private spawnEntry(spec: AcpSpawnSpec): PoolEntry {
    const entryId = `acp-${spec.agentId}-${++entryCounter}`;
    const child = spawn(spec.binary, spec.args, {
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spec.cwd,
      shell: spec.shell,
      windowsVerbatimArguments: process.platform === 'win32' && !spec.shell,
    });

    const entry: PoolEntry = {
      id: entryId,
      agentId: spec.agentId,
      child,
      // transport placeholder — replaced right after construction below (the
      // hooks closure needs `entry`, which needs `transport`; break the cycle
      // with a late assignment).
      transport: null as unknown as AcpTransport,
      ready: Promise.resolve(),
      alive: true,
      fingerprint: spec.fingerprint,
      binary: spec.binary,
      sessions: new Map(),
      earlyEvents: [],
    };

    const transport = new AcpTransport(
      (json) => {
        if (child.stdin?.writable) child.stdin.write(json, 'utf8');
      },
      {
        onTransportEvent: (ev) => this.routeTransportEvent(entry, ev),
        killChild: () => {
          // Transport-level timeout (initialize/session/new hung) or degraded
          // stream — the process is useless to every session. Finalize (fails
          // attached runs) and kill the tree.
          if (!entry.alive) return;
          this.finalizeEntry(entry, null, new Error(
            `ACP transport killed ${spec.agentId} process (timeout or protocol error)`,
          ));
          killAgentProcessTree(child);
        },
      },
    );
    entry.transport = transport;

    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE/EOF on a dying process is expected — the close handler reports it.
      if (err.code === 'EPIPE' || err.code === 'EOF') return;
      this.routeTransportEvent(entry, { type: 'error', message: `stdin error: ${err.message}` });
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => transport.feed(chunk));

    const stderrDecoder = createStderrDecoder();
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stderrDecoder ? stderrDecoder(chunk) : chunk.toString('utf8');
      // stderr counts as activity — reset idle timers on pending requests so
      // cold-start plugin loading doesn't trip the handshake timeout.
      transport.noteActivity();
      this.handleStderr(entry, spec.agentId, text);
    });

    child.on('error', (err) => {
      this.routeTransportEvent(entry, { type: 'error', message: `Spawn error: ${err.message}` });
      this.finalizeEntry(entry, 1, new Error(`Spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      transport.flush();
      this.finalizeEntry(entry, code, new Error(`${spec.binary} process exited (code=${code})`));
    });

    // initialize — transport-level (no sessionId): a process that can't
    // complete the handshake is useless to every future session.
    entry.ready = transport.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      { idleTimeoutMs: spec.idleTimeoutMs, absoluteTimeoutMs: spec.absoluteTimeoutMs },
    ).then(() => undefined).catch((err) => {
      this.finalizeEntry(entry, null, err instanceof Error ? err : new Error(String(err)));
      killAgentProcessTree(child);
      // Decorate so the caller (RunManager) can build the same
      // "last stderr: …" diagnostic the pre-pool path had.
      if (entry.lastStderrLine && err instanceof Error) {
        (err as Error & { acpLastStderrLine?: string }).acpLastStderrLine = entry.lastStderrLine;
      }
      throw err;
    });

    return entry;
  }

  /**
   * Finalize a dying/dead entry EXACTLY once (close + error + explicit kill
   * paths can all race in). Snapshots per-session state BEFORE rejectAll —
   * rejectAll clears both the pending map (hasPendingFor) and the cancelled
   * markers (isCancelled), so reading them afterwards would see zeros.
   */
  private finalizeEntry(entry: PoolEntry, code: number | null, error: Error): void {
    if (!entry.alive) return;
    entry.alive = false;
    this.disarmIdleTimer(entry);
    this.removeEntry(entry);
    this.hooks.onEntryDrained?.(entry.agentId, entry.id, error.message);

    // Snapshot BEFORE rejectAll wipes transport state.
    const snapshots: Array<{ att: AcpSessionAttachment; wasCancelled: boolean; hadPendingPrompt: boolean }> = [];
    for (const [sessionId, att] of entry.sessions) {
      snapshots.push({
        att,
        wasCancelled: entry.transport.isCancelled(sessionId),
        hadPendingPrompt: entry.transport.hasPendingFor(sessionId),
      });
    }

    entry.transport.rejectAll(error);
    entry.sessions.clear();

    for (const snap of snapshots) {
      try {
        snap.att.onProcessExit({
          code,
          wasCancelled: snap.wasCancelled,
          hadPendingPrompt: snap.hadPendingPrompt,
          exitError: error,
        });
      } catch {
        // A throwing run callback must not prevent the other runs from
        // learning their process died.
      }
    }
  }

  /** Route a transport-level diagnostic to all sessions, or buffer pre-attach. */
  private routeTransportEvent(entry: PoolEntry, ev: AgentEvent): void {
    if (entry.sessions.size === 0) {
      if (entry.earlyEvents.length < EARLY_EVENTS_CAP) entry.earlyEvents.push(ev);
      return;
    }
    this.broadcast(entry, ev);
  }

  private broadcast(entry: PoolEntry, ev: AgentEvent): void {
    for (const att of entry.sessions.values()) {
      try { att.sink(ev); } catch { /* sink error must not break the broadcast */ }
    }
  }

  /** Split stderr into lines, track lastStderrLine, classify + route each. */
  private handleStderr(entry: PoolEntry, agentId: string, text: string): void {
    if (!text) return;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      entry.lastStderrLine = line;
      this.routeTransportEvent(entry, classifyAcpStderrLine(agentId, line));
    }
  }

  private armIdleTimer(entry: PoolEntry): void {
    if (this.idleTtlMs <= 0) return; // ≤0 disables idle eviction
    this.disarmIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      // Re-check: a session may have attached between arming and firing.
      if (entry.sessions.size === 0 && entry.alive) {
        this.finalizeEntry(entry, null, new Error(
          `ACP process evicted after ${Math.round(this.idleTtlMs / 1000)}s idle`,
        ));
        killAgentProcessTree(entry.child);
      }
    }, this.idleTtlMs);
    // Never hold the Node event loop open just for pool eviction — the daemon
    // must stay shutdowntable, and node --test must exit cleanly.
    entry.idleTimer.unref?.();
  }

  private disarmIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private removeEntry(entry: PoolEntry): void {
    if (this.entries.get(entry.agentId) === entry) {
      this.entries.delete(entry.agentId);
    }
  }

  private findEntryById(entryId: string): PoolEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.id === entryId) return entry;
    }
    return undefined;
  }
}
