import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJsonEventStreamHandler } from '../../src/core/streams/json-event-stream.js';
import type { AgentEvent } from '@molio/contracts';

function collectEvents(kind: string, lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const handler = createJsonEventStreamHandler(kind, (ev) => events.push(ev));
  for (const line of lines) {
    handler.feed(line + '\n');
  }
  handler.flush();
  return events;
}

describe('json-event-stream dispatcher', () => {
  describe('codex events', () => {
    it('should parse thread.started as status', () => {
      const events = collectEvents('codex', [
        JSON.stringify({ type: 'thread.started' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'initializing');
      }
    });

    it('should parse item.started command_execution as tool_use', () => {
      const events = collectEvents('codex', [
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', id: 'cmd-1', command: 'echo hello' },
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'tool_use');
      if (events[0]!.type === 'tool_use') {
        assert.equal(events[0]!.name, 'Bash');
        assert.equal(events[0]!.id, 'cmd-1');
      }
    });

    it('should parse item.completed agent_message as text_delta', () => {
      const events = collectEvents('codex', [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Hello world' },
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'text_delta');
      if (events[0]!.type === 'text_delta') {
        assert.equal(events[0]!.delta, 'Hello world');
      }
    });

    it('should parse turn.completed as usage', () => {
      const events = collectEvents('codex', [
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'usage');
      if (events[0]!.type === 'usage') {
        assert.equal(events[0]!.usage?.input_tokens, 100);
        assert.equal(events[0]!.usage?.output_tokens, 50);
      }
    });

    it('should parse error events', () => {
      const events = collectEvents('codex', [
        JSON.stringify({ type: 'error', message: 'Something went wrong' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'error');
      if (events[0]!.type === 'error') {
        assert.equal(events[0]!.message, 'Something went wrong');
      }
    });
  });

  describe('gemini events', () => {
    it('should parse init event as status', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'init' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'initializing');
      }
    });

    it('should parse message event as text_delta', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'message', content: 'Hello from Gemini' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'text_delta');
      if (events[0]!.type === 'text_delta') {
        assert.equal(events[0]!.delta, 'Hello from Gemini');
      }
    });

    it('should parse result event as usage', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'result', usage: { input_tokens: 200, output_tokens: 80 } }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'usage');
    });

    it('should parse done event as turn_end', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'done' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'turn_end');
    });
  });

  describe('unknown events', () => {
    it('should emit unknown events as raw', () => {
      const events = collectEvents('unknown', [
        JSON.stringify({ type: 'something_else', data: 'test' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'raw');
    });
  });

  describe('malformed JSON', () => {
    it('should emit non-JSON lines as raw', () => {
      const events = collectEvents('codex', [
        'this is not json',
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'raw');
    });
  });
});
