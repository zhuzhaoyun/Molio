import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';
import { createCodexStreamHandler } from '../src/core/streams/codex-stream.js';

/**
 * Tests for Codex stream handler — parses Codex CLI JSONL output.
 * Covers: thread lifecycle, command execution, agent messages, error dedup.
 */

function collectEvents(): { events: AgentEvent[]; onEvent: (ev: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (ev: AgentEvent) => events.push(ev) };
}

function feedLines(handler: { feed: (chunk: string) => void }, ...lines: string[]): void {
  handler.feed(lines.join('\n') + '\n');
}

describe('Codex stream handler', () => {
  describe('thread lifecycle events', () => {
    it('should emit status initializing on thread.started', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({ type: 'thread.started' }));

      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'initializing');
      }
    });

    it('should emit status running on turn.started', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({ type: 'turn.started' }));

      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'status');
      if (events[0]!.type === 'status') {
        assert.equal(events[0]!.label, 'running');
      }
    });
  });

  describe('command execution', () => {
    it('should emit tool_use on item.started with command_execution', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', id: 'cmd_001', command: 'ls -la' },
      }));

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);
      if (toolUseEvents[0]!.type === 'tool_use') {
        assert.equal(toolUseEvents[0]!.id, 'cmd_001');
        assert.equal(toolUseEvents[0]!.name, 'Bash');
        assert.deepEqual(toolUseEvents[0]!.input, { command: 'ls -la' });
      }
    });

    it('should not emit duplicate tool_use for same command id', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', id: 'cmd_002', command: 'pwd' },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', id: 'cmd_002', command: 'pwd' },
        }),
      );

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);
    });

    it('should emit tool_result on item.completed with command_execution', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_003',
          command: 'echo hello',
          aggregated_output: 'hello\n',
          exit_code: 0,
        },
      }));

      // Should emit tool_use (from completed) + tool_result
      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      assert.equal(toolUseEvents.length, 1);

      const toolResults = events.filter((e) => e.type === 'tool_result');
      assert.equal(toolResults.length, 1);
      if (toolResults[0]!.type === 'tool_result') {
        assert.equal(toolResults[0]!.toolUseId, 'cmd_003');
        assert.equal(toolResults[0]!.content, 'hello\n');
        assert.equal(toolResults[0]!.isError, false);
      }
    });

    it('should mark tool_result as error when exit_code is non-zero', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          id: 'cmd_004',
          command: 'cat nonexistent',
          aggregated_output: 'cat: nonexistent: No such file',
          exit_code: 1,
        },
      }));

      const toolResults = events.filter((e) => e.type === 'tool_result');
      assert.equal(toolResults.length, 1);
      if (toolResults[0]!.type === 'tool_result') {
        assert.equal(toolResults[0]!.isError, true);
      }
    });

    it('should not emit duplicate tool_use when both started and completed arrive', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', id: 'cmd_005', command: 'git status' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            id: 'cmd_005',
            command: 'git status',
            aggregated_output: 'clean',
            exit_code: 0,
          },
        }),
      );

      const toolUseEvents = events.filter((e) => e.type === 'tool_use');
      // Only one tool_use: from item.started; item.completed should not duplicate
      assert.equal(toolUseEvents.length, 1);
    });
  });

  describe('agent messages', () => {
    it('should emit text_delta for agent_message items', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'The result is 42.' },
      }));

      const textEvents = events.filter((e) => e.type === 'text_delta');
      assert.equal(textEvents.length, 1);
      if (textEvents[0]!.type === 'text_delta') {
        assert.equal(textEvents[0]!.delta, 'The result is 42.');
      }
    });

    it('should insert newline between consecutive agent_message items', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'First paragraph.' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Second paragraph.' },
        }),
      );

      const textEvents = events.filter((e) => e.type === 'text_delta');
      assert.equal(textEvents.length, 3); // first + newline + second
      if (textEvents[0]!.type === 'text_delta') {
        assert.equal(textEvents[0]!.delta, 'First paragraph.');
      }
      if (textEvents[1]!.type === 'text_delta') {
        assert.equal(textEvents[1]!.delta, '\n');
      }
      if (textEvents[2]!.type === 'text_delta') {
        assert.equal(textEvents[2]!.delta, 'Second paragraph.');
      }
    });

    it('should not insert newline when agent_message follows non-message item', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', id: 'cmd_010', command: 'ls', aggregated_output: 'file.ts', exit_code: 0 },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Found the file.' },
        }),
      );

      // After command_execution, lastWasAgentMessage is reset to false
      // So no newline before the agent_message
      const textEvents = events.filter((e) => e.type === 'text_delta');
      assert.equal(textEvents.length, 1);
      if (textEvents[0]!.type === 'text_delta') {
        assert.equal(textEvents[0]!.delta, 'Found the file.');
      }
    });
  });

  describe('usage tracking', () => {
    it('should emit usage event on turn.completed with usage data', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 2000,
          output_tokens: 500,
          cached_input_tokens: 800,
        },
      }));

      const usageEvents = events.filter((e) => e.type === 'usage');
      assert.equal(usageEvents.length, 1);
      if (usageEvents[0]!.type === 'usage') {
        assert.equal(usageEvents[0]!.usage?.input_tokens, 2000);
        assert.equal(usageEvents[0]!.usage?.output_tokens, 500);
        assert.equal(usageEvents[0]!.usage?.cached_read_tokens, 800);
      }
    });

    it('should handle turn.completed without usage data', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({ type: 'turn.completed' }));

      // Should not emit usage event
      const usageEvents = events.filter((e) => e.type === 'usage');
      assert.equal(usageEvents.length, 0);
    });
  });

  describe('error handling', () => {
    it('should emit error event on type=error', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded',
      }));

      const errorEvents = events.filter((e) => e.type === 'error');
      assert.equal(errorEvents.length, 1);
      if (errorEvents[0]!.type === 'error') {
        assert.equal(errorEvents[0]!.message, 'Rate limit exceeded');
      }
    });

    it('should deduplicate multiple error events', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({ type: 'error', message: 'First error' }),
        JSON.stringify({ type: 'error', message: 'Second error' }),
      );

      const errorEvents = events.filter((e) => e.type === 'error');
      assert.equal(errorEvents.length, 1);
      if (errorEvents[0]!.type === 'error') {
        assert.equal(errorEvents[0]!.message, 'First error');
      }
    });

    it('should emit error on turn.failed', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, JSON.stringify({ type: 'turn.failed' }));

      const errorEvents = events.filter((e) => e.type === 'error');
      assert.equal(errorEvents.length, 1);
      if (errorEvents[0]!.type === 'error') {
        assert.equal(errorEvents[0]!.message, 'Codex turn failed');
      }
    });

    it('should deduplicate error from turn.failed if error already emitted', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({ type: 'error', message: 'Original error' }),
        JSON.stringify({ type: 'turn.failed' }),
      );

      const errorEvents = events.filter((e) => e.type === 'error');
      assert.equal(errorEvents.length, 1);
      if (errorEvents[0]!.type === 'error') {
        assert.equal(errorEvents[0]!.message, 'Original error');
      }
    });
  });

  describe('invalid JSON handling', () => {
    it('should emit raw event for non-JSON lines', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler, 'not valid json at all');

      const rawEvents = events.filter((e) => e.type === 'raw');
      assert.equal(rawEvents.length, 1);
      if (rawEvents[0]!.type === 'raw') {
        assert.equal(rawEvents[0]!.line, 'not valid json at all');
      }
    });
  });

  describe('complete flow', () => {
    it('should handle a full thread lifecycle', () => {
      const { events, onEvent } = collectEvents();
      const handler = createCodexStreamHandler(onEvent);

      feedLines(handler,
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', id: 'cmd_100', command: 'cat file.ts' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', id: 'cmd_100', command: 'cat file.ts', aggregated_output: 'const x = 1;', exit_code: 0 },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'The file contains a constant declaration.' },
        }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 500, output_tokens: 50 },
        }),
      );

      // Verify event types in order
      const types = events.map((e) => e.type);
      assert.ok(types.includes('status'));      // thread.started + turn.started
      assert.ok(types.includes('tool_use'));    // command_execution started
      assert.ok(types.includes('tool_result')); // command_execution completed
      assert.ok(types.includes('text_delta'));  // agent_message
      assert.ok(types.includes('usage'));       // turn.completed
    });
  });
});
