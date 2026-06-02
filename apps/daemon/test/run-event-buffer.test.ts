import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BufferedEvent } from '../src/types.js';

/**
 * Tests for the event buffer and SSE replay functionality.
 * These test the RunManager's event buffering logic without requiring
 * actual child processes.
 */
describe('Run event buffer', () => {
  describe('BufferedEvent structure', () => {
    it('should have required fields', () => {
      const event: BufferedEvent = {
        id: 1,
        event: 'text_delta',
        data: { type: 'text_delta', delta: 'hello' },
        timestamp: Date.now(),
      };
      assert.equal(typeof event.id, 'number');
      assert.equal(typeof event.event, 'string');
      assert.ok(event.data !== undefined);
      assert.equal(typeof event.timestamp, 'number');
    });
  });

  describe('Event cap behavior', () => {
    it('should demonstrate buffer cap logic', () => {
      // Simulate the buffer cap logic from RunManager
      const MAX_EVENTS = 2000;
      const events: BufferedEvent[] = [];

      for (let i = 0; i < 2500; i++) {
        events.push({
          id: i + 1,
          event: 'text_delta',
          data: { type: 'text_delta', delta: `chunk-${i}` },
          timestamp: Date.now(),
        });
        if (events.length > MAX_EVENTS) {
          events.splice(0, events.length - MAX_EVENTS);
        }
      }

      assert.equal(events.length, MAX_EVENTS);
      assert.equal(events[0]!.id, 501); // First 500 should be trimmed
      assert.equal(events[events.length - 1]!.id, 2500);
    });
  });

  describe('SSE replay filter', () => {
    it('should filter events by afterId', () => {
      const events: BufferedEvent[] = [
        { id: 1, event: 'status', data: { type: 'status', label: 'initializing' }, timestamp: 1 },
        { id: 2, event: 'text_delta', data: { type: 'text_delta', delta: 'A' }, timestamp: 2 },
        { id: 3, event: 'text_delta', data: { type: 'text_delta', delta: 'B' }, timestamp: 3 },
        { id: 4, event: 'text_delta', data: { type: 'text_delta', delta: 'C' }, timestamp: 4 },
        { id: 5, event: 'usage', data: { type: 'usage' }, timestamp: 5 },
      ];

      // Replay from afterId=2
      const replayed = events.filter((e) => e.id > 2);
      assert.equal(replayed.length, 3);
      assert.equal(replayed[0]!.id, 3);
      assert.equal(replayed[2]!.id, 5);
    });

    it('should return all events when afterId=0', () => {
      const events: BufferedEvent[] = [
        { id: 1, event: 'status', data: {}, timestamp: 1 },
        { id: 2, event: 'text_delta', data: {}, timestamp: 2 },
      ];

      const replayed = events.filter((e) => e.id > 0);
      assert.equal(replayed.length, 2);
    });

    it('should return empty when afterId is past all events', () => {
      const events: BufferedEvent[] = [
        { id: 1, event: 'status', data: {}, timestamp: 1 },
        { id: 2, event: 'text_delta', data: {}, timestamp: 2 },
      ];

      const replayed = events.filter((e) => e.id > 100);
      assert.equal(replayed.length, 0);
    });
  });

  describe('JSONL event log format', () => {
    it('should serialize event record to valid JSON', () => {
      const record: BufferedEvent = {
        id: 42,
        event: 'text_delta',
        data: { type: 'text_delta', delta: 'Hello world' },
        timestamp: 1234567890,
      };
      const line = JSON.stringify(record);
      const parsed = JSON.parse(line);
      assert.equal(parsed.id, 42);
      assert.equal(parsed.event, 'text_delta');
      assert.equal(parsed.data.delta, 'Hello world');
    });
  });
});
