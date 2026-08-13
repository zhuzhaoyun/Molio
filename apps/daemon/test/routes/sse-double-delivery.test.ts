import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import type { RunManager } from '../../src/core/RunManager.js';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Regression test: the live SSE stream could deliver the SAME event frame
 * TWICE to a single consumer during a burst.
 *
 * Root cause: controller.enqueue() is re-entrant in Node's ReadableStream.
 * When the consumer has a pending read() (a live renderer almost always
 * does), enqueue() fulfills that read from the chunk, sees desiredSize > 0,
 * and SYNCHRONOUSLY invokes pull(). At that instant the live callback has NOT
 * yet run `lastDeliveredId = lastId` (it runs AFTER safeEnqueue), so pull()
 * observes a stale lastDeliveredId, decides the event currently being
 * delivered was "missed", and replays it from the run buffer — the same
 * frame delivered twice. The frontend appends text_delta content per frame
 * with no seq-dedup (useChatCore.updateWithEvent), so a burst whose
 * text_delta got doubled rendered the assistant reply duplicated (the
 * "hello" → duplicated greeting report on v0.3.42).
 *
 * Introduced by PR #192 (commit 5c5ae37, SSE backpressure). The suite's
 * existing stall test only asserted the SECOND stream's content after a
 * reconnect — it never counted how many times the FIRST stream delivered
 * each frame, so this slipped through.
 *
 * Reproduced 5/5 with this pattern: an active (always-reading) consumer +
 * events emitted ~1ms apart. Env hooks (ping/stall) are NOT set here on
 * purpose — an active consumer never stalls, and shorter pings would only
 * add noise frames.
 */
const { createSSEStream } = await import('../../src/sse.js');

class MockRunManager {
  private bufferedEvents: Map<string, BufferedEvent[]> = new Map();
  private eventListeners: Map<string, Set<(ev: AgentEvent) => void>> = new Map();
  private lastEventIds: Map<string, number> = new Map();

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
    return false;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SSE live stream (burst, active consumer)', () => {
  it('should deliver each event exactly once — no double-delivery on burst', async () => {
    const mock = new MockRunManager();
    const runId = 'burst-1';
    const { stream, cleanup } = createSSEStream(mock as unknown as RunManager, runId, 0);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // Active consumer: always has a pending read(), like a live renderer.
    const frames: string[] = [];
    const consumer = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    })();

    // Burst of events ~1ms apart — the hello reply on v0.3.42 arrived this
    // way (7 events in ~3.5s, closely spaced).
    const deltas = ['A', 'B', 'C', 'D', 'E'];
    for (const d of deltas) {
      mock.emitLiveEvent(runId, { type: 'text_delta', delta: d });
      await sleep(1);
    }

    // Let any pending pull/replay settle, then stop the stream cleanly.
    await sleep(50);
    cleanup();
    try { await reader.cancel(); } catch { /* already cancelled */ }
    await consumer;

    // Extract event-frame seqs (ping frames carry no `id:` line).
    const seqs = frames
      .map((f) => f.match(/^id: (\d+)/)?.[1])
      .filter((s): s is string => s !== undefined)
      .map(Number);

    // 5 events → exactly 5 frames, seqs 1..5 each exactly once.
    assert.deepEqual(
      seqs.slice().sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
      `expected each event frame exactly once, got seqs=${JSON.stringify(seqs)}`,
    );
  });
});
