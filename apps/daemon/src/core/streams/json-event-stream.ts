/**
 * Multi-kind JSON event stream dispatcher.
 * Routes events to kind-specific handlers based on the eventParser field.
 *
 * Supported kinds: codex, gemini (extensible).
 */

import type { AgentEvent, StreamHandler, UsageInfo } from '@molio/contracts';
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
//
// Actual Gemini CLI stream-json event shapes (v0.46.0):
//   init:         { type: "init", timestamp, session_id, model }
//   message:      { type: "message", timestamp, role: "user"|"assistant", content, delta?: true }
//   tool_use:     { type: "tool_use", timestamp, tool_name, tool_id, parameters }
//   tool_result:  { type: "tool_result", timestamp, tool_id, status: "success"|"error", output, error?: { type, message } }
//   error:        { type: "error", timestamp, severity: "warning"|"error", message }
//   result:       { type: "result", timestamp, status: "success"|"error", error?: { type, message }, stats: { total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models } }

function handleGeminiEvent(obj: unknown, onEvent: (ev: AgentEvent) => void): boolean {
  if (!isRecord(obj)) return false;

  // Init event
  if (obj.type === 'init' || obj.type === 'system') {
    onEvent({ type: 'status', label: 'initializing' });
    return true;
  }

  // Text message — only emit assistant messages (skip user echo)
  if (obj.type === 'message' && typeof obj.content === 'string') {
    if (obj.role !== 'user') {
      onEvent({ type: 'text_delta', delta: obj.content });
    }
    return true;
  }

  // Alternative text format (fallback, not seen in v0.46 but kept for safety)
  if (obj.type === 'text' && typeof obj.text === 'string') {
    onEvent({ type: 'text_delta', delta: obj.text });
    return true;
  }

  // Tool use
  if (obj.type === 'tool_use' && typeof obj.tool_id === 'string') {
    onEvent({
      type: 'tool_use',
      id: obj.tool_id,
      name: typeof obj.tool_name === 'string' ? obj.tool_name : 'unknown',
      input: isRecord(obj.parameters) ? obj.parameters : {},
    });
    return true;
  }

  // Tool result
  if (obj.type === 'tool_result' && typeof obj.tool_id === 'string') {
    onEvent({
      type: 'tool_result',
      toolUseId: obj.tool_id,
      content: typeof obj.output === 'string' ? obj.output : '',
      isError: obj.status === 'error',
    });
    return true;
  }

  // Error (non-fatal warnings and errors during the stream)
  if (obj.type === 'error' && typeof obj.message === 'string') {
    onEvent({ type: 'error', message: obj.message });
    return true;
  }

  // Result — final event: usage stats + turn completion
  if (obj.type === 'result') {
    // Emit error if the result indicates failure
    if (obj.status === 'error' && isRecord(obj.error) && typeof obj.error.message === 'string') {
      onEvent({ type: 'error', message: obj.error.message });
    }

    // Emit usage stats from the `stats` field
    if (isRecord(obj.stats)) {
      const usage: UsageInfo = {};
      if (typeof obj.stats.input_tokens === 'number') usage.input_tokens = obj.stats.input_tokens;
      if (typeof obj.stats.output_tokens === 'number') usage.output_tokens = obj.stats.output_tokens;
      if (typeof obj.stats.cached === 'number') usage.cached_read_tokens = obj.stats.cached;
      if (Object.keys(usage).length > 0) {
        onEvent({ type: 'usage', usage });
      }
    }

    // Emit turn_end to signal completion
    onEvent({
      type: 'turn_end',
      stopReason: obj.status === 'error' ? 'error' : 'end_turn',
    });
    return true;
  }

  // Legacy turn_end / done (kept for backward compat, not emitted by v0.46)
  if (obj.type === 'turn_end' || obj.type === 'done') {
    onEvent({ type: 'turn_end', stopReason: typeof obj.stop_reason === 'string' ? obj.stop_reason : 'end_turn' });
    return true;
  }

  return false;
}

// ─── Helpers ───

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
