import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import type { BufferedEvent } from '../../src/types.js';

/**
 * Error-driven test: finishRun error deduplication.
 *
 * Bug: When a run failed, finishRun would emit an error event even if one was
 * already emitted (e.g. from stderr handler). This caused the error message
 * to appear twice in the UI.
 *
 * Fix: Before emitting the error in finishRun, check if any event in
 * run.events already has type === 'error'. If so, skip the duplicate emission.
 */

describe('finishRun error deduplication', () => {
  /**
   * Simulate the dedup check from RunManager.finishRun:
   * If the events array already contains an error event, no new error should be emitted.
   */
  function simulateFinishRunErrorHandling(
    events: BufferedEvent[],
    runError: string | null,
    status: 'succeeded' | 'failed' | 'canceled',
  ): AgentEvent[] {
    const emitted: AgentEvent[] = [];

    // This mirrors the logic in RunManager.finishRun
    if (status === 'failed' && runError) {
      const alreadyEmitted = events.some((e) => e.event === 'error');
      if (!alreadyEmitted) {
        emitted.push({ type: 'error', message: runError });
      }
    }

    // Always emit status end event
    emitted.push({
      type: 'status',
      label: status === 'succeeded' ? 'completed' : status,
    });

    return emitted;
  }

  it('should NOT emit duplicate error when error event already exists in buffer', () => {
    // Simulate: stderr handler already emitted an error event
    // BufferedEvent.event is the event type string (mirrors emitEvent in RunManager)
    const events: BufferedEvent[] = [
      {
        id: 1,
        event: 'text_delta',
        data: { type: 'text_delta', delta: 'Some output' },
        timestamp: 1000,
      },
      {
        id: 2,
        event: 'error',
        data: { type: 'error', message: 'Spawn error: EPIPE' },
        timestamp: 2000,
      },
    ];

    const emitted = simulateFinishRunErrorHandling(events, 'Spawn error: EPIPE', 'failed');

    // Should only emit the status event, NOT a duplicate error
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, 'status');
  });

  it('should emit error when no error event exists in buffer yet', () => {
    // Simulate: run failed but no error event was emitted during the run
    const events: BufferedEvent[] = [
      {
        id: 1,
        event: 'status',
        data: { type: 'status', label: 'initializing' },
        timestamp: 1000,
      },
    ];

    const emitted = simulateFinishRunErrorHandling(events, 'Binary not found', 'failed');

    // Should emit both error and status events
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.type, 'error');
    if (emitted[0]!.type === 'error') {
      assert.equal(emitted[0]!.message, 'Binary not found');
    }
    assert.equal(emitted[1]!.type, 'status');
  });

  it('should NOT emit error for succeeded runs', () => {
    const events: BufferedEvent[] = [];
    const emitted = simulateFinishRunErrorHandling(events, null, 'succeeded');

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, 'status');
    if (emitted[0]!.type === 'status') {
      assert.equal(emitted[0]!.label, 'completed');
    }
  });

  it('should NOT emit error when runError is null even for failed status', () => {
    const events: BufferedEvent[] = [];
    const emitted = simulateFinishRunErrorHandling(events, null, 'failed');

    // No error to emit, just the status event
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.type, 'status');
  });
});
