import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import { createSSEStream } from '../../src/sse.js';
import type { RunManager } from '../../src/core/RunManager.js';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Tests for SSE stream creation and frame formatting.
 * Uses a mock RunManager to test the SSE logic without real child processes.
 */

class MockRunManager {
  private bufferedEvents: Map<string, BufferedEvent[]> = new Map();
  private terminalRuns: Set<string> = new Set();
  private eventListeners: Map<string, Set<(ev: AgentEvent) => void>> = new Map();
  private lastEventIds: Map<string, number> = new Map();

  setBufferedEvents(runId: string, events: BufferedEvent[]): void {
    this.bufferedEvents.set(runId, events);
  }

  setTerminal(runId: string, isTerminal: boolean): void {
    if (isTerminal) {
      this.terminalRuns.add(runId);
    } else {
      this.terminalRuns.delete(runId);
    }
  }

  setLastEventId(runId: string, id: number): void {
    this.lastEventIds.set(runId, id);
  }

  /** Emit a live event AND buffer it (mirrors RunManager.emitEvent: buffer
   *  first with an id from lastEventId+1, then fan out — so getLastEventId and
   *  getBufferedEvents stay consistent with what the SSE stream has replayed). */
  emitLiveEvent(runId: string, event: AgentEvent): void {
    const id = (this.lastEventIds.get(runId) ?? 0) + 1;
    this.lastEventIds.set(runId, id);
    const list = this.bufferedEvents.get(runId) ?? [];
    list.push({ id, event: String(event.type), data: event, timestamp: Date.now() });
    this.bufferedEvents.set(runId, list);
    const listeners = this.eventListeners.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
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
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Set());
    }
    this.eventListeners.get(runId)!.add(callback);
    return () => {
      this.eventListeners.get(runId)?.delete(callback);
    };
  }

  getLastEventId(runId: string): number {
    return this.lastEventIds.get(runId) ?? 0;
  }
}

describe('SSE stream', () => {
  describe('event replay', () => {
    it('should replay buffered events when afterId=0', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-1', [
        { id: 1, event: 'status', data: { type: 'status', label: 'running' }, timestamp: 1 },
        { id: 2, event: 'text_delta', data: { type: 'text_delta', delta: 'Hello' }, timestamp: 2 },
      ]);
      mock.setTerminal('run-1', true);

      const { stream } = createSSEStream(mock as unknown as RunManager, 'run-1', 0);
      const reader = stream.getReader();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      assert.equal(chunks.length, 2);

      // Parse first frame
      const frame1 = chunks[0]!;
      assert.ok(frame1.includes('id: 1'));
      assert.ok(frame1.includes('"seq":1'));
      assert.ok(frame1.includes('"runId":"run-1"'));

      // Parse second frame
      const frame2 = chunks[1]!;
      assert.ok(frame2.includes('id: 2'));
      assert.ok(frame2.includes('"delta":"Hello"'));
    });

    it('should filter replayed events by afterId', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-2', [
        { id: 1, event: 'status', data: { type: 'status', label: 'init' }, timestamp: 1 },
        { id: 2, event: 'text_delta', data: { type: 'text_delta', delta: 'A' }, timestamp: 2 },
        { id: 3, event: 'text_delta', data: { type: 'text_delta', delta: 'B' }, timestamp: 3 },
      ]);
      mock.setTerminal('run-2', true);

      const { stream } = createSSEStream(mock as unknown as RunManager, 'run-2', 2);
      const reader = stream.getReader();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      // Should only get event id=3 (afterId=2)
      assert.equal(chunks.length, 1);
      assert.ok(chunks[0]!.includes('id: 3'));
      assert.ok(chunks[0]!.includes('"delta":"B"'));
    });

    it('should return empty when no events match afterId', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-3', [
        { id: 1, event: 'status', data: {}, timestamp: 1 },
      ]);
      mock.setTerminal('run-3', true);

      const { stream } = createSSEStream(mock as unknown as RunManager, 'run-3', 100);
      const reader = stream.getReader();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }

      assert.equal(chunks.length, 0);
    });
  });

  describe('terminal run handling', () => {
    it('should close stream immediately after replay for terminal runs', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-4', [
        { id: 1, event: 'status', data: { type: 'status', label: 'completed' }, timestamp: 1 },
      ]);
      mock.setTerminal('run-4', true);

      const { stream } = createSSEStream(mock as unknown as RunManager, 'run-4', 0);
      const reader = stream.getReader();

      // Read all data
      const { done } = await reader.read();
      // After reading the replayed event, the stream should be done
      const nextRead = await reader.read();
      assert.equal(nextRead.done, true);
    });
  });

  describe('live event subscription', () => {
    it('should subscribe to live events for non-terminal runs', async () => {
      const mock = new MockRunManager();
      // Consistent with real RunManager: the run already emitted events 1-4
      // (buffered), lastEventId=4, so the next live event is seq 5. getLastEventId
      // must be the source of the frame's seq — NOT a counter inside createSSEStream.
      mock.setBufferedEvents('run-5', [
        { id: 1, event: 'status', data: { type: 'status', label: 'running' }, timestamp: 1 },
        { id: 2, event: 'text_delta', data: { type: 'text_delta', delta: 'A' }, timestamp: 2 },
        { id: 3, event: 'text_delta', data: { type: 'text_delta', delta: 'B' }, timestamp: 3 },
        { id: 4, event: 'text_delta', data: { type: 'text_delta', delta: 'C' }, timestamp: 4 },
      ]);
      mock.setTerminal('run-5', false);
      mock.setLastEventId('run-5', 4);

      const { stream, cleanup } = createSSEStream(mock as unknown as RunManager, 'run-5', 0);
      const reader = stream.getReader();

      // Drain the replayed events (1-4)
      for (let i = 0; i < 4; i++) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Emit a live event → seq 5
      mock.emitLiveEvent('run-5', { type: 'text_delta', delta: 'Live update' });

      // Read the event
      const { value, done } = await reader.read();
      assert.equal(done, false);
      const frame = new TextDecoder().decode(value);
      assert.ok(frame.includes('id: 5'));
      assert.ok(frame.includes('"delta":"Live update"'));

      // Cleanup
      cleanup();
      reader.cancel();
    });
  });

  describe('SSE frame format', () => {
    it('should format frames with correct SSE syntax', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-6', [
        { id: 42, event: 'text_delta', data: { type: 'text_delta', delta: 'Test' }, timestamp: 123 },
      ]);
      mock.setTerminal('run-6', true);

      const { stream } = createSSEStream(mock as unknown as RunManager, 'run-6', 0);
      const reader = stream.getReader();
      const { value } = await reader.read();
      const frame = new TextDecoder().decode(value);

      // SSE format: id: <id>\ndata: <json>\n\n
      assert.ok(frame.startsWith('id: 42\n'));
      assert.ok(frame.includes('data: '));
      assert.ok(frame.endsWith('\n\n'));

      // Parse the data payload
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))!;
      const jsonStr = dataLine.slice(6); // Remove 'data: ' prefix
      const parsed = JSON.parse(jsonStr);
      assert.equal(parsed.seq, 42);
      assert.equal(parsed.runId, 'run-6');
      assert.deepEqual(parsed.event, { type: 'text_delta', delta: 'Test' });
    });
  });

  describe('cleanup', () => {
    it('should unsubscribe on stream cancel', async () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-7', []);
      mock.setTerminal('run-7', false);

      const { stream, cleanup } = createSSEStream(mock as unknown as RunManager, 'run-7', 0);
      const reader = stream.getReader();

      // Cancel the stream
      await reader.cancel();

      // Cleanup should be safe to call
      cleanup();
    });

    it('should handle cleanup being called multiple times', () => {
      const mock = new MockRunManager();
      mock.setBufferedEvents('run-8', []);
      mock.setTerminal('run-8', false);

      const { cleanup } = createSSEStream(mock as unknown as RunManager, 'run-8', 0);

      // Call cleanup multiple times — should not throw
      cleanup();
      cleanup();
      cleanup();
    });
  });
});
