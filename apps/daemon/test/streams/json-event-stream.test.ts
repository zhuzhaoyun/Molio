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
        JSON.stringify({ type: 'init', session_id: 'abc', model: 'gemini-2.5-pro' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'initializing');
      }
    });

    it('should parse assistant message event as text_delta', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello from Gemini', delta: true }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'text_delta');
      if (events[0]!.type === 'text_delta') {
        assert.equal(events[0]!.delta, 'Hello from Gemini');
      }
    });

    it('should skip user message echo', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'message', role: 'user', content: 'my prompt' }),
      ]);
      assert.equal(events.length, 0);
    });

    it('should parse tool_use event', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({
          type: 'tool_use',
          tool_name: 'read_file',
          tool_id: 'tool-123',
          parameters: { path: '/tmp/test.txt' },
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'tool_use');
      if (events[0]!.type === 'tool_use') {
        assert.equal(events[0]!.id, 'tool-123');
        assert.equal(events[0]!.name, 'read_file');
        assert.deepEqual(events[0]!.input, { path: '/tmp/test.txt' });
      }
    });

    it('should parse tool_result event (success)', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({
          type: 'tool_result',
          tool_id: 'tool-123',
          status: 'success',
          output: 'file contents here',
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'tool_result');
      if (events[0]!.type === 'tool_result') {
        assert.equal(events[0]!.toolUseId, 'tool-123');
        assert.equal(events[0]!.content, 'file contents here');
        assert.equal(events[0]!.isError, false);
      }
    });

    it('should parse tool_result event (error)', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({
          type: 'tool_result',
          tool_id: 'tool-456',
          status: 'error',
          output: '',
          error: { type: 'TOOL_EXECUTION_ERROR', message: 'permission denied' },
        }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'tool_result');
      if (events[0]!.type === 'tool_result') {
        assert.equal(events[0]!.toolUseId, 'tool-456');
        assert.equal(events[0]!.isError, true);
      }
    });

    it('should parse error event', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({ type: 'error', severity: 'warning', message: 'Rate limit approaching' }),
      ]);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'error');
      if (events[0]!.type === 'error') {
        assert.equal(events[0]!.message, 'Rate limit approaching');
      }
    });

    it('should parse result event as usage + turn_end', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({
          type: 'result',
          status: 'success',
          stats: {
            total_tokens: 280,
            input_tokens: 200,
            output_tokens: 80,
            cached: 50,
            duration_ms: 1234,
            tool_calls: 0,
            models: {},
          },
        }),
      ]);
      assert.equal(events.length, 2);
      assert.equal(events[0]!.type, 'usage');
      if (events[0]!.type === 'usage') {
        assert.equal(events[0]!.usage?.input_tokens, 200);
        assert.equal(events[0]!.usage?.output_tokens, 80);
        assert.equal(events[0]!.usage?.cached_read_tokens, 50);
      }
      assert.equal(events[1]!.type, 'turn_end');
      if (events[1]!.type === 'turn_end') {
        assert.equal(events[1]!.stopReason, 'end_turn');
      }
    });

    it('should parse result event with error status', () => {
      const events = collectEvents('gemini', [
        JSON.stringify({
          type: 'result',
          status: 'error',
          error: { type: 'API_ERROR', message: 'Quota exceeded' },
          stats: { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0, duration_ms: 100, tool_calls: 0, models: {} },
        }),
      ]);
      // error + usage (0 is still a number) + turn_end
      assert.equal(events.length, 3);
      assert.equal(events[0]!.type, 'error');
      if (events[0]!.type === 'error') {
        assert.equal(events[0]!.message, 'Quota exceeded');
      }
      assert.equal(events[1]!.type, 'usage');
      assert.equal(events[2]!.type, 'turn_end');
      if (events[2]!.type === 'turn_end') {
        assert.equal(events[2]!.stopReason, 'error');
      }
    });

    it('should parse legacy done event as turn_end', () => {
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
