import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from '../../src/core/RunManager.js';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Regression test: SSE resume connection loses events emitted during the
 * replay-drain window.
 *
 * createSSEStream Phase 1 replays buffered events UNCONDITIONALLY, then Phase 3
 * gates live events behind controller.desiredSize > 0. When a client re-subscribes
 * (KB 会话重挂载 / watchdog reconnect), the replay burst fills the stream's queue
 * (desiredSize → 0); any live event emitted by the still-running agent BEFORE the
 * client drains the replay is silently dropped. The drop is unrecoverable for
 * this connection (stall-close takes ~60s, the reply finishes in seconds) — the
 * resumed reply appears permanently stuck. This is the daemon-side root cause of
 * "切页返回后只有当前显示的会话在继续，其他会话中断".
 *
 * Env hooks are set BEFORE importing sse.js (read at module load). node --test
 * gives each file its own process.
 */
process.env['MOLIO_TEST_SSE_PING_MS'] = '20';
process.env['MOLIO_TEST_SSE_STALL_TICKS'] = '3';

const { createSSEStream } = await import('../../src/sse.js');

/** Faithful MockRunManager: emitLiveEvent ALSO buffers + bumps lastEventId,
 *  mirroring real RunManager.emitEvent (buffer first, then fan out). */
class MockRunManager {
  private bufferedEvents: Map<string, BufferedEvent[]> = new Map();
  private terminalRuns: Set<string> = new Set();
  private eventListeners: Map<string, Set<(ev: AgentEvent) => void>> = new Map();
  private lastEventIds: Map<string, number> = new Map();

  setBufferedEvents(runId: string, events: BufferedEvent[]): void {
    this.bufferedEvents.set(runId, events);
  }

  setTerminal(runId: string, isTerminal: boolean): void {
    if (isTerminal) this.terminalRuns.add(runId);
    else this.terminalRuns.delete(runId);
  }

  setLastEventId(runId: string, id: number): void {
    this.lastEventIds.set(runId, id);
  }

  /** Emit a live event AND buffer it (mirrors RunManager.emitEvent). */
  emitLiveEvent(runId: string, event: AgentEvent): void {
    const id = (this.lastEventIds.get(runId) ?? 0) + 1;
    this.lastEventIds.set(runId, id);
    const list = this.bufferedEvents.get(runId) ?? [];
    list.push({ id, event: String(event.type), data: event, timestamp: Date.now() });
    this.bufferedEvents.set(runId, list);
    const listeners = this.eventListeners.get(runId);
    if (listeners) for (const l of listeners) l(event);
  }

  listenerCount(runId: string): number {
    return this.eventListeners.get(runId)?.size ?? 0;
  }

  getBufferedEvents(runId: string, afterId: number = 0): BufferedEvent[] | null {
    const events = this.bufferedEvents.get(runId);
    if (!events) return null;
    return events.filter((e) => e.id > afterId);
  }

  isTerminal(runId: string): boolean {
    return this.terminalRuns.has(runId);
  }

  onEvent(runId: string, callback: (event: AgentEvent) => void): (() => void) | null {
    if (!this.eventListeners.has(runId)) this.eventListeners.set(runId, new Set());
    this.eventListeners.get(runId)!.add(callback);
    return () => { this.eventListeners.get(runId)?.delete(callback); };
  }

  getLastEventId(runId: string): number {
    return this.lastEventIds.get(runId) ?? 0;
  }
}

const decoder = new TextDecoder();

/** Read with a deadline; resolves null on timeout so a missing event fails the
 *  assertion instead of hanging the whole suite. */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1500,
): Promise<({ done: boolean; value?: Uint8Array }) | null> {
  return Promise.race([
    reader.read(),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), timeoutMs); }),
  ]);
}

/** Drain up to `max` chunks, collecting decoded text. */
async function readUpTo(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max: number,
): Promise<string[]> {
  const chunks: string[] = [];
  for (let i = 0; i < max; i++) {
    const result = await readWithTimeout(reader);
    if (result === null) break; // no more events within the deadline
    if (result.done) break;
    if (result.value) chunks.push(decoder.decode(result.value));
  }
  return chunks;
}

describe('SSE resume (live events during replay-drain window)', () => {
  it('must not lose live events emitted before the consumer drains the replay', async () => {
    const mock = new MockRunManager();
    // Run is mid-stream: buffer holds the replayed status (seq 1), run not terminal.
    mock.setBufferedEvents('resume-1', [
      { id: 1, event: 'status', data: { type: 'status', label: 'running' }, timestamp: 1 },
    ]);
    mock.setTerminal('resume-1', false);
    mock.setLastEventId('resume-1', 1);

    const { stream, cleanup } = createSSEStream(mock as unknown as RunManager, 'resume-1', 0);
    const reader = stream.getReader();

    // The agent keeps emitting while the client hasn't yet drained the replayed
    // status (queue full, desiredSize=0) — the exact resume race.
    mock.emitLiveEvent('resume-1', { type: 'text_delta', delta: 'continued ' });
    mock.emitLiveEvent('resume-1', { type: 'text_delta', delta: 'reply.' });

    // Client drains the replay, then the rest must follow (status + 2 deltas,
    // plus possible pings).
    const chunks = await readUpTo(reader, 8);

    const joined = chunks.join('');
    assert.ok(chunks.length >= 3, `expected status + 2 deltas, got ${chunks.length}: ${joined}`);
    assert.ok(joined.includes('"label":"running"'), 'status replay missing');
    assert.ok(joined.includes('"delta":"continued '), `continued delta lost: ${joined}`);
    assert.ok(joined.includes('"delta":"reply."'), `final delta lost: ${joined}`);

    cleanup();
    await reader.cancel();
    assert.equal(mock.listenerCount('resume-1'), 0, 'cleanup must unsubscribe');
  });
});
