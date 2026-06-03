import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@kge/contracts';
import { createClaudeStreamHandler } from '../src/core/streams/claude-stream.js';

/**
 * Tests for Claude stream handler — parses Claude Code CLI JSONL output.
 * Each test feeds JSONL lines via handler.feed() and collects emitted events.
 */

function collectEvents(): { events: AgentEvent[]; onEvent: (ev: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (ev: AgentEvent) => events.push(ev) };
}

function feedLines(handler: { feed: (chunk: string) => void }, ...lines: string[]): void {
  handler.feed(lines.join('\n') + '\n');
}

describe('Claude stream handler', () => {
  describe('system init event', () => {
    it('should emit status event with model on system/init', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-4-20250514',
      }));

      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'initializing');
        assert.equal(events[0]!.model, 'claude-sonnet-4-20250514');
      }
    });
  });

  describe('stream_event: message_start', () => {
    it('should emit streaming status with ttftMs', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg_001' },
          ttft_ms: 142,
        },
      }));

      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'streaming');
        assert.equal(events[0]!.ttftMs, 142);
      }
    });
  });

  describe('stream_event: text streaming', () => {
    it('should emit text_delta for content_block_delta with text_delta', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      // Set up message context
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_002' } },
      }));

      // Start content block
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      }));

      // Text delta
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello, world!' },
        },
      }));

      // Should have: status (message_start) + text_delta
      const textEvents = events.filter((e) => e.type === 'text_delta');
      assert.equal(textEvents.length, 1);
      if (textEvents[0]!.type === 'text_delta') {
        assert.equal(textEvents[0]!.delta, 'Hello, world!');
      }
    });

    it('should mark messageId as text-streamed to avoid duplicate in assistant block', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      // Stream the text via content_block_delta
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_003' } },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Streamed text' },
        },
      }));

      // Now the full assistant message arrives with the same text
      feedLines(handler, JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_003',
          content: [{ type: 'text', text: 'Streamed text' }],
          stop_reason: 'end_turn',
        },
      }));

      // Should NOT have a duplicate text_delta from the assistant block
      const textEvents = events.filter((e) => e.type === 'text_delta');
      assert.equal(textEvents.length, 1);
    });
  });

  describe('stream_event: thinking streaming', () => {
    it('should emit thinking_start then thinking_delta', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_004' } },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me think...' },
        },
      }));

      const thinkingStart = events.find((e) => e.type === 'thinking_start');
      assert.ok(thinkingStart);

      const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta');
      assert.equal(thinkingDeltas.length, 1);
      if (thinkingDeltas[0]!.type === 'thinking_delta') {
        assert.equal(thinkingDeltas[0]!.delta, 'Let me think...');
      }
    });
  });

  describe('stream_event: tool_use via content_block_stop', () => {
    it('should emit tool_use with parsed JSON input on content_block_stop', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_005' } },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_001', name: 'Read' },
        },
      }));
      // Stream partial JSON input
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '/src/main.ts"}' },
        },
      }));
      // Close the block
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      }));

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);
      if (toolUseEvents[0]!.type === 'tool_use') {
        assert.equal(toolUseEvents[0]!.id, 'toolu_001');
        assert.equal(toolUseEvents[0]!.name, 'Read');
        assert.deepEqual(toolUseEvents[0]!.input, { file_path: '/src/main.ts' });
      }
    });

    it('should not emit tool_use if JSON input is malformed', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_006' } },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_002', name: 'Bash' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{invalid json}' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }));

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 0);
    });
  });

  describe('assistant message block', () => {
    it('should emit turn_end on stop_reason', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_010',
          content: [],
          stop_reason: 'end_turn',
        },
      }));

      const turnEnd = events.find((e) => e.type === 'turn_end');
      assert.ok(turnEnd);
      if (turnEnd!.type === 'turn_end') {
        assert.equal(turnEnd!.stopReason, 'end_turn');
      }
    });

    it('should emit turn_end with tool_use stop_reason', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_011',
          content: [],
          stop_reason: 'tool_use',
        },
      }));

      const turnEnd = events.find((e) => e.type === 'turn_end');
      assert.ok(turnEnd);
      if (turnEnd!.type === 'turn_end') {
        assert.equal(turnEnd!.stopReason, 'tool_use');
      }
    });

    it('should emit tool_use for non-streamed tool blocks', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_012',
          content: [
            { type: 'tool_use', id: 'toolu_010', name: 'Write', input: { file: 'test.ts' } },
          ],
          stop_reason: 'tool_use',
        },
      }));

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);
      if (toolUseEvents[0]!.type === 'tool_use') {
        assert.equal(toolUseEvents[0]!.id, 'toolu_010');
        assert.equal(toolUseEvents[0]!.name, 'Write');
      }
    });

    it('should deduplicate tool_use already emitted from stream', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      // First: stream the tool_use (which emits tool_use event + adds to streamedToolUseIds)
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_013' } },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_020', name: 'Edit' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file":"a.ts"}' },
        },
      }));
      feedLines(handler, JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }));

      // Then: the full assistant message arrives with the same tool_use
      feedLines(handler, JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_013',
          content: [
            { type: 'tool_use', id: 'toolu_020', name: 'Edit', input: { file: 'a.ts' } },
          ],
          stop_reason: 'tool_use',
        },
      }));

      // Should only have one tool_use event (from stream), not duplicated
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);
    });
  });

  describe('user message with tool_result', () => {
    it('should emit tool_result event', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_030', content: 'File contents...', is_error: false },
          ],
        },
      }));

      const toolResults = events.filter((e) => e.type === 'tool_result');
      assert.equal(toolResults.length, 1);
      if (toolResults[0]!.type === 'tool_result') {
        assert.equal(toolResults[0]!.toolUseId, 'toolu_030');
        assert.equal(toolResults[0]!.content, 'File contents...');
        assert.equal(toolResults[0]!.isError, false);
      }
    });

    it('should emit tool_result with isError=true', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_031', content: 'Error: file not found', is_error: true },
          ],
        },
      }));

      const toolResults = events.filter((e) => e.type === 'tool_result');
      assert.equal(toolResults.length, 1);
      if (toolResults[0]!.type === 'tool_result') {
        assert.equal(toolResults[0]!.isError, true);
      }
    });
  });

  describe('result event (usage)', () => {
    it('should emit usage event with cost and duration', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'result',
        usage: { input_tokens: 1500, output_tokens: 300 },
        total_cost_usd: 0.0042,
        duration_ms: 3200,
      }));

      const usageEvents = events.filter((e) => e.type === 'usage');
      assert.equal(usageEvents.length, 1);
      if (usageEvents[0]!.type === 'usage') {
        assert.deepEqual(usageEvents[0]!.usage, { input_tokens: 1500, output_tokens: 300 });
        assert.equal(usageEvents[0]!.costUsd, 0.0042);
        assert.equal(usageEvents[0]!.durationMs, 3200);
      }
    });
  });

  describe('invalid JSON handling', () => {
    it('should emit raw event for non-JSON lines', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(handler, 'this is not json');

      const rawEvents = events.filter((e) => e.type === 'raw');
      assert.equal(rawEvents.length, 1);
      if (rawEvents[0]!.type === 'raw') {
        assert.equal(rawEvents[0]!.line, 'this is not json');
      }
    });
  });

  describe('multi-turn conversation flow', () => {
    it('should handle a complete init → stream → result flow', () => {
      const { events, onEvent } = collectEvents();
      const handler = createClaudeStreamHandler(onEvent);

      feedLines(
        handler,
        // Init
        JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-20250514' }),
        // Message start
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg_100' }, ttft_ms: 200 },
        }),
        // Text delta
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'The answer is 42.' },
          },
        }),
        // Full assistant message
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_100',
            content: [{ type: 'text', text: 'The answer is 42.' }],
            stop_reason: 'end_turn',
          },
        }),
        // Result
        JSON.stringify({
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 10 },
          total_cost_usd: 0.001,
          duration_ms: 1500,
        }),
      );

      // Verify event sequence
      assert.equal(events[0]!.type, 'status'); // init
      assert.equal(events[1]!.type, 'status'); // streaming
      assert.equal(events[2]!.type, 'text_delta'); // streamed text
      // No duplicate text_delta from assistant block
      assert.equal(events[3]!.type, 'turn_end');
      assert.equal(events[4]!.type, 'usage');
    });
  });
});
