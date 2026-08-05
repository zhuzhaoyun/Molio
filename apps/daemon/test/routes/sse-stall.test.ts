import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from '../../src/core/RunManager.js';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Regression test: the SSE stream used to enqueue pings and live events
 * unconditionally. A client that stopped reading (minimized/throttled
 * renderer during a long run) made the daemon buffer the run's entire event
 * output in memory — part of the day-long 3GB memory-growth report.
 *
 * The stream now checks controller.desiredSize: while the consumer is
 * stalled it stops enqueueing, and after MAX_STALLED_PINGS consecutive
 * stalled ticks it closes the stream so the client reconnects and replays
 * buffered events (no data loss).
 *
 * Env hooks are set BEFORE importing sse.js (read at module load). node
 * --test gives each file its own process, so these don't leak to other
 * suites.
 */
process.env['MOLIO_TEST_SSE_PING_MS'] = '20';
process.env['MOLIO_TEST_SSE_STALL_TICKS'] = '3';

const { createSSEStream } = await import('../../src/sse.js');

class MockRunManager {
  private bufferedEvents: Map<string, BufferedEvent[]> = new Map();
  private terminalRuns: Set<string> = new Set();
  private eventListeners: Map<string, Set<(ev: AgentEvent) => void>> = new Map();
  private lastEventIds: Map<string, number> = new Map();

  setTerminal(runId: string, isTerminal: boolean): void {
    if (isTerminal) this.terminalRuns.add(runId);
    else this.terminalRuns.delete(runId);
  }

  /** Emit a live event AND buffer it (mirrors RunManager.emitEvent) so a
   * reconnecting client can replay it. */
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

/** Read until the stream closes; THROWS if it doesn't close in time (a fake
 * `done` here would mask the exact regression this suite exists to catch). */
async function drainUntilDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 3000,
): Promise<string[]> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (result === null) {
      throw new Error('stream did not close before deadline — stall-close did not fire');
    }
    if (result.done) return chunks;
    if (result.value) chunks.push(decoder.decode(result.value));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SSE backpressure (stalled consumer)', () => {
  it('should close the stream after the consumer stalls for MAX_STALLED_PINGS ticks', async () => {
    const mock = new MockRunManager();
    mock.setTerminal('stall-1', false);

    const { stream } = createSSEStream(mock as unknown as RunManager, 'stall-1', 0);
    const reader = stream.getReader();

    // Fill the stream's internal queue so desiredSize drops to 0, then issue
    // NO read requests — simulating a throttled/hidden renderer. (An
    // outstanding read() would drain the queue and make the consumer look
    // healthy, which is exactly the real-world distinction this relies on.)
    mock.emitLiveEvent('stall-1', { type: 'text_delta', delta: 'x' });
    mock.emitLiveEvent('stall-1', { type: 'text_delta', delta: 'y' });

    // ping=20ms × 3 stalled ticks → close at ~60ms. Give it 500ms of slack
    // WITHOUT reading, then drain: a closed stream yields its queued chunks
    // plus done promptly.
    await sleep(500);
    const chunks = await drainUntilDone(reader, 1000);
    assert.ok(chunks.length >= 1, 'the initially queued event should still be delivered');

    // The close path must have unsubscribed — no leaked listener.
    assert.equal(mock.listenerCount('stall-1'), 0, 'stall-close must unsubscribe the listener');
  });

  it('should not close a stream whose consumer keeps reading (healthy path)', async () => {
    const mock = new MockRunManager();
    mock.setTerminal('healthy-1', false);

    const { stream, cleanup } = createSSEStream(mock as unknown as RunManager, 'healthy-1', 0);
    const reader = stream.getReader();

    // Actively consume for ~200ms — many ping intervals. A healthy consumer
    // resets the stall counter every tick, so no close must happen.
    let pings = 0;
    const until = Date.now() + 200;
    while (Date.now() < until) {
      const { done, value } = await reader.read();
      assert.equal(done, false, 'stream must stay open for an active consumer');
      if (value && new TextDecoder().decode(value).includes('ping')) pings++;
    }
    assert.ok(pings >= 2, `expected several pings while consuming, got ${pings}`);

    cleanup();
    await reader.cancel();
    assert.equal(mock.listenerCount('healthy-1'), 0);
  });

  it('should lose no events: events emitted during a stall replay on reconnect', async () => {
    const mock = new MockRunManager();
    mock.setTerminal('replay-1', false);

    const { stream } = createSSEStream(mock as unknown as RunManager, 'replay-1', 0);
    const reader = stream.getReader();

    // Stall the consumer (no reads), then emit events INTO THE BUFFER while
    // stalled. They are skipped on the live stream but remain in run.events.
    mock.emitLiveEvent('replay-1', { type: 'text_delta', delta: 'buffered-1' });
    mock.emitLiveEvent('replay-1', { type: 'text_delta', delta: 'buffered-2' });
    mock.emitLiveEvent('replay-1', { type: 'text_delta', delta: 'buffered-3' });

    await sleep(500);                   // let the stall-close fire (~60ms)
    await drainUntilDone(reader, 1000); // proves the stream actually closed

    // Client reconnects (EventSource auto-reconnect / watchdog) → daemon
    // replays everything buffered with id > 0. Mark terminal BEFORE creating
    // the stream: start() replays then closes immediately for terminal runs.
    mock.setTerminal('replay-1', true);
    const { stream: stream2 } = createSSEStream(mock as unknown as RunManager, 'replay-1', 0);
    const reader2 = stream2.getReader();
    const replayed = await drainUntilDone(reader2, 2000);

    const joined = replayed.join('');
    assert.ok(joined.includes('buffered-1'), 'event 1 must survive the stall');
    assert.ok(joined.includes('buffered-2'), 'event 2 must survive the stall');
    assert.ok(joined.includes('buffered-3'), 'event 3 must survive the stall');
  });
});
