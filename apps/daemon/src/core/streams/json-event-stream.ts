/**
 * Multi-kind JSON event stream dispatcher.
 * Routes events to kind-specific handlers based on the eventParser field.
 *
 * Supported kinds: codex, gemini (extensible).
 */

import type { AgentEvent, StreamHandler, UsageInfo } from '@kge/contracts';
import { createJsonlParser } from './jsonl-parser.js';

/**
 * Create a stream handler that dispatches JSONL events to kind-specific handlers.
 */
export function createJsonEventStreamHandler(
  kind: string,
  onEvent: (ev: AgentEvent) => void,
): StreamHandler {
  function handleLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      onEvent({ type: 'raw', line });
      return;
    }

    if (kind === 'codex' && handleCodexEvent(obj, onEvent)) return;
    if (kind === 'gemini' && handleGeminiEvent(obj, onEvent)) return;

    // Unrecognized kind or event — pass through as raw
    onEvent({ type: 'raw', line });
  }

  return createJsonlParser(handleLine);
}

// ─── Codex handler (refactored from codex-stream.ts) ───

const codexToolUseIds = new Set<string>();
let codexErrorEmitted = false;

function handleCodexEvent(obj: unknown, onEvent: (ev: AgentEvent) => void): boolean {
  if (!isRecord(obj)) return false;

  // Errors
  if (obj.type === 'error') {
    const message = typeof obj.message === 'string' ? obj.message : 'Codex error';
    if (!codexErrorEmitted) {
      codexErrorEmitted = true;
      onEvent({ type: 'error', message });
    }
    return true;
  }

  if (obj.type === 'turn.failed') {
    if (!codexErrorEmitted) {
      codexErrorEmitted = true;
      onEvent({ type: 'error', message: 'Codex turn failed' });
    }
    return true;
  }

  // Lifecycle
  if (obj.type === 'thread.started') {
    onEvent({ type: 'status', label: 'initializing' });
    return true;
  }
  if (obj.type === 'turn.started') {
    onEvent({ type: 'status', label: 'running' });
    return true;
  }

  // Tool use (command_execution)
  if (obj.type === 'item.started' && isRecord(obj.item)) {
    const item = obj.item;
    if (item.type === 'command_execution' && typeof item.id === 'string' && !codexToolUseIds.has(item.id)) {
      codexToolUseIds.add(item.id);
      onEvent({
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: typeof item.command === 'string' ? item.command : '' },
      });
    }
    return true;
  }

  if (obj.type === 'item.completed' && isRecord(obj.item)) {
    const item = obj.item;

    // Tool result
    if (item.type === 'command_execution' && typeof item.id === 'string') {
      if (!codexToolUseIds.has(item.id)) {
        codexToolUseIds.add(item.id);
        onEvent({
          type: 'tool_use',
          id: item.id,
          name: 'Bash',
          input: { command: typeof item.command === 'string' ? item.command : '' },
        });
      }
      onEvent({
        type: 'tool_result',
        toolUseId: item.id,
        content: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
        isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : false,
      });
      return true;
    }

    // Agent text message
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      onEvent({ type: 'text_delta', delta: item.text });
      return true;
    }
  }

  // Usage
  if (obj.type === 'turn.completed' && isRecord(obj.usage)) {
    const u = obj.usage;
    const usage: UsageInfo = {};
    if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
    if (typeof u.cached_input_tokens === 'number') usage.cached_read_tokens = u.cached_input_tokens;
    onEvent({ type: 'usage', usage });
    return true;
  }

  return false;
}

// ─── Gemini handler ───

function handleGeminiEvent(obj: unknown, onEvent: (ev: AgentEvent) => void): boolean {
  if (!isRecord(obj)) return false;

  // Init event
  if (obj.type === 'init' || obj.type === 'system') {
    onEvent({ type: 'status', label: 'initializing' });
    return true;
  }

  // Text message
  if (obj.type === 'message' && typeof obj.content === 'string') {
    onEvent({ type: 'text_delta', delta: obj.content });
    return true;
  }

  // Alternative text format
  if (obj.type === 'text' && typeof obj.text === 'string') {
    onEvent({ type: 'text_delta', delta: obj.text });
    return true;
  }

  // Result / usage
  if (obj.type === 'result') {
    const usage: UsageInfo = {};
    if (isRecord(obj.usage)) {
      if (typeof obj.usage.input_tokens === 'number') usage.input_tokens = obj.usage.input_tokens;
      if (typeof obj.usage.output_tokens === 'number') usage.output_tokens = obj.usage.output_tokens;
    }
    onEvent({ type: 'usage', usage });
    return true;
  }

  // Turn end
  if (obj.type === 'turn_end' || obj.type === 'done') {
    onEvent({ type: 'turn_end', stopReason: typeof obj.stop_reason === 'string' ? obj.stop_reason : 'end_turn' });
    return true;
  }

  // Error
  if (obj.type === 'error' && typeof obj.message === 'string') {
    onEvent({ type: 'error', message: obj.message });
    return true;
  }

  return false;
}

// ─── Helpers ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
