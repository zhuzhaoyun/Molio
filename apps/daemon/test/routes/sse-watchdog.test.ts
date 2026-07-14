import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEStream } from '../../src/sse.js';
import type { RunManager } from '../../src/core/RunManager.js';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Tests for the SSE watchdog support layer:
 *  - ping is emitted as a `data:` frame (NOT a `:ping` comment line) so the
 *    browser's EventSource onmessage fires and the frontend watchdog can use
 *    ping as a keepalive heartbeat. A regression to `:ping` would silently break
 *    the watchdog (comment lines don't trigger onmessage), and the E2E suite
 *    can't catch this because it mocks SSE with its own server — so this unit
 *    test is the only guard.
 *  - replay with ?after= (the watchdog reconnect path) returns only events
 *    with id > afterId, so reconnecting to a live run recovers the missed tail.
 */

const PING_ENV = 'MOLIO_TEST_SSE_PING_MS';

function makeMockRunManager(): RunManager {
  return {
    getBufferedEvents: (_runId: string, _afterId = 0): BufferedEvent[] | null => [],
    isTerminal: (_runId: string): boolean => false,
    onEvent: (_runId: string, _cb: (ev: any) => void): (() => void) | null => () => {},
    getLastEventId: (_runId: string): number => 0,
  } as unknown as RunManager;
}

describe('SSE watchdog support', () => {
  describe('ping frame', () => {
    it('emits ping as a `data:` frame, not a `:ping` comment line', async () => {
      process.env[PING_ENV] = '5'; // 5ms ping so the test doesn't sleep 15s
      try {
        const { stream, cleanup } = createSSEStream(makeMockRunManager(), 'ping-run', 0);
        const reader = stream.getReader();
        try {
          const { value } = await reader.read();
          const frame = new TextDecoder().decode(value);
          // Must be a `data:` frame so browser onmessage fires — the watchdog's heartbeat.
          assert.ok(
            frame.startsWith('data: ping\n'),
            `expected ping data frame, got: ${JSON.stringify(frame)}`,
          );
          assert.ok(!frame.startsWith(':ping'), 'ping must NOT be a comment line (onmessage would not fire)');
          // No `id:` line → not buffered → replay won't flood stale pings on reconnect.
          assert.ok(!frame.includes('id:'), 'ping must not carry an id (would buffer it for replay)');
        } finally {
          cleanup();
          await reader.cancel();
        }
      } finally {
        delete process.env[PING_ENV];
      }
    });
  });

  describe('?after= replay (watchdog reconnect path)', () => {
    it('replays only events with id > afterId so a reconnect recovers the missed tail', async () => {
      const mock = {
        ...makeMockRunManager(),
        getBufferedEvents: (_runId: string, afterId = 0): BufferedEvent[] | null => [
          { id: 10, event: 'text_delta', data: { type: 'text_delta', delta: 'old' }, timestamp: 1 },
          { id: 11, event: 'text_delta', data: { type: 'text_delta', delta: 'missed' }, timestamp: 2 },
        ].filter((e) => e.id > afterId),
        isTerminal: () => true, // close immediately after replay so the test can drain
      } as unknown as RunManager;

      const { stream } = createSSEStream(mock, 'replay-run', 10);
      const reader = stream.getReader();
      const frames: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        frames.push(new TextDecoder().decode(value));
      }
      // Only id=11 should be replayed (afterId=10 filtered out id=10).
      assert.equal(frames.length, 1);
      assert.ok(frames[0]!.includes('id: 11'));
      assert.ok(frames[0]!.includes('"delta":"missed"'));
    });
  });
});
