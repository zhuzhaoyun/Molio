import type { AgentEvent, StreamHandler, UsageInfo } from '../types.js';
import { createJsonlParser } from './jsonl-parser.js';

export function createCodexStreamHandler(
  onEvent: (ev: AgentEvent) => void,
): StreamHandler {
  const toolUseIds = new Set<string>();
  let errorEmitted = false;
  let lastWasAgentMessage = false;

  function handleObject(obj: Record<string, unknown>): void {
    // ── Errors ──
    if (obj['type'] === 'error') {
      const message = typeof obj['message'] === 'string'
        ? obj['message'] as string
        : 'Codex error';
      if (!errorEmitted) {
        errorEmitted = true;
        onEvent({ type: 'error', message });
      }
      return;
    }

    if (obj['type'] === 'turn.failed') {
      if (!errorEmitted) {
        errorEmitted = true;
        onEvent({ type: 'error', message: 'Codex turn failed' });
      }
      return;
    }

    // ── Lifecycle ──
    if (obj['type'] === 'thread.started') {
      onEvent({ type: 'status', label: 'initializing' });
      return;
    }
    if (obj['type'] === 'turn.started') {
      onEvent({ type: 'status', label: 'running' });
      return;
    }

    // ── Tool use (command_execution) ──
    if (obj['type'] === 'item.started' && typeof obj['item'] === 'object') {
      const item = obj['item'] as Record<string, unknown>;
      if (item['type'] === 'command_execution'
        && typeof item['id'] === 'string'
        && !toolUseIds.has(item['id'] as string)) {
        toolUseIds.add(item['id'] as string);
        onEvent({
          type: 'tool_use',
          id: item['id'] as string,
          name: 'Bash',
          input: { command: typeof item['command'] === 'string' ? item['command'] : '' },
        });
      }
      lastWasAgentMessage = false;
      return;
    }

    if (obj['type'] === 'item.completed' && typeof obj['item'] === 'object') {
      const item = obj['item'] as Record<string, unknown>;

      // Tool result
      if (item['type'] === 'command_execution' && typeof item['id'] === 'string') {
        if (!toolUseIds.has(item['id'] as string)) {
          toolUseIds.add(item['id'] as string);
          onEvent({
            type: 'tool_use',
            id: item['id'] as string,
            name: 'Bash',
            input: { command: typeof item['command'] === 'string' ? item['command'] : '' },
          });
        }
        onEvent({
          type: 'tool_result',
          toolUseId: item['id'] as string,
          content: typeof item['aggregated_output'] === 'string'
            ? item['aggregated_output'] as string
            : '',
          isError: typeof item['exit_code'] === 'number'
            ? (item['exit_code'] as number) !== 0
            : false,
        });
        lastWasAgentMessage = false;
        return;
      }

      // Agent text message
      if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        // Insert newline boundary between consecutive agent messages
        if (lastWasAgentMessage) {
          onEvent({ type: 'text_delta', delta: '\n' });
        }
        onEvent({ type: 'text_delta', delta: item['text'] as string });
        lastWasAgentMessage = true;
        return;
      }

      lastWasAgentMessage = false;
      return;
    }

    // ── Usage ──
    if (obj['type'] === 'turn.completed' && typeof obj['usage'] === 'object') {
      const u = obj['usage'] as Record<string, unknown>;
      const usage: UsageInfo = {};
      if (typeof u['input_tokens'] === 'number') usage.input_tokens = u['input_tokens'] as number;
      if (typeof u['output_tokens'] === 'number') usage.output_tokens = u['output_tokens'] as number;
      if (typeof u['cached_input_tokens'] === 'number') usage.cached_read_tokens = u['cached_input_tokens'] as number;
      onEvent({ type: 'usage', usage });
      return;
    }
  }

  return createJsonlParser((line) => {
    try {
      handleObject(JSON.parse(line));
    } catch {
      onEvent({ type: 'raw', line });
    }
  });
}
