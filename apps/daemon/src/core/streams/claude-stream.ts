import type { AgentEvent, StreamHandler, UsageInfo } from '@molio/contracts';
import { createJsonlParser } from './jsonl-parser.js';

interface BlockState {
  type?: string;
  name?: string;
  id?: string;
  input: string;
}

export function createClaudeStreamHandler(
  onEvent: (ev: AgentEvent) => void,
): StreamHandler {
  const blocks = new Map<string, BlockState>();
  const streamedToolUseIds = new Set<string>();
  let currentMessageId: string | null = null;
  const textStreamed = new Set<string>();
  const thinkingStreamed = new Set<string>();
  // After turn_end with end_turn, suppress subsequent assistant text
  // (Claude Code CLI outputs idle greeting messages between turns).
  // Reset to false when a new user message arrives (multi-turn follow-up).
  let turnComplete = false;

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function handleObject(obj: Record<string, unknown>): void {
    if (obj['type'] === 'system' && obj['subtype'] === 'init') {
      onEvent({ type: 'status', label: 'initializing', model: obj['model'] as string });
      return;
    }

    if (obj['type'] === 'stream_event' && typeof obj['event'] === 'object') {
      handleStreamEvent(obj['event'] as Record<string, unknown>);
      return;
    }

    if (obj['type'] === 'assistant' && typeof obj['message'] === 'object') {
      const msg = obj['message'] as Record<string, unknown>;
      const msgId = typeof msg['id'] === 'string' ? msg['id'] : null;
      if (msgId) currentMessageId = msgId;

      // If a previous turn already ended, suppress all content from this
      // assistant block — it's a CLI idle/greeting message, not task output.
      if (turnComplete) return;

      const content = Array.isArray(msg['content']) ? msg['content'] : [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;

        if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
          if (streamedToolUseIds.has(b['id'] as string)) {
            streamedToolUseIds.delete(b['id'] as string);
            continue;
          }
          onEvent({
            type: 'tool_use',
            id: b['id'] as string,
            name: b['name'] as string,
            input: b['input'] ?? null,
          });
        } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
          if (!textStreamed.has(msgId ?? '')) {
            onEvent({ type: 'text_delta', delta: b['text'] as string });
          }
        } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
          if (!thinkingStreamed.has(msgId ?? '')) {
            onEvent({ type: 'thinking_delta', delta: b['thinking'] as string });
          }
        }
      }

      if (typeof msg['stop_reason'] === 'string') {
        const reason = msg['stop_reason'] as string;
        onEvent({ type: 'turn_end', stopReason: reason });
        if (reason === 'end_turn') turnComplete = true;
      }
      return;
    }

    if (obj['type'] === 'user' && typeof obj['message'] === 'object') {
      // New user message means a follow-up turn — reset the guard
      turnComplete = false;
      const msg = obj['message'] as Record<string, unknown>;
      const content = Array.isArray(msg['content']) ? msg['content'] : [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: b['tool_use_id'] as string,
            content: typeof b['content'] === 'string'
              ? b['content'] as string
              : JSON.stringify(b['content']),
            isError: Boolean(b['is_error']),
          });
        }
      }
      return;
    }

    if (obj['type'] === 'result') {
      onEvent({
        type: 'usage',
        usage: obj['usage'] as UsageInfo,
        costUsd: obj['total_cost_usd'] as number,
        durationMs: obj['duration_ms'] as number,
      });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>): void {
    // Suppress all stream events after turn ends (CLI idle output),
    // until reset by a new user message in handleObject.
    if (turnComplete) return;

    if (ev['type'] === 'message_start') {
      const msg = typeof ev['message'] === 'object'
        ? ev['message'] as Record<string, unknown>
        : {};
      currentMessageId = typeof msg['id'] === 'string' ? msg['id'] as string : null;
      if (typeof ev['ttft_ms'] === 'number') {
        onEvent({ type: 'status', label: 'streaming', ttftMs: ev['ttft_ms'] as number });
      }
      return;
    }

    if (ev['type'] === 'content_block_start' && typeof ev['content_block'] === 'object') {
      const block = ev['content_block'] as Record<string, unknown>;
      blocks.set(blockKey(ev['index']), {
        type: block['type'] as string,
        name: block['name'] as string,
        id: block['id'] as string,
        input: '',
      });
      if (block['type'] === 'thinking') {
        onEvent({ type: 'thinking_start' });
      }
      return;
    }

    if (ev['type'] === 'content_block_delta' && typeof ev['delta'] === 'object') {
      const delta = ev['delta'] as Record<string, unknown>;
      const state = blocks.get(blockKey(ev['index']));

      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta['text'] as string });
        return;
      }
      if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        if (currentMessageId) thinkingStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta['thinking'] as string });
        return;
      }
      if (delta['type'] === 'input_json_delta'
        && typeof delta['partial_json'] === 'string'
        && state) {
        state.input += delta['partial_json'] as string;
        return;
      }
    }

    if (ev['type'] === 'content_block_stop') {
      const state = blocks.get(blockKey(ev['index']));
      if (state?.type === 'tool_use' && state.id && state.input.trim()) {
        try {
          onEvent({
            type: 'tool_use',
            id: state.id,
            name: state.name ?? '',
            input: JSON.parse(state.input),
          });
          streamedToolUseIds.add(state.id);
        } catch {
          // Malformed JSON -- let the assistant wrapper handle it
        }
      }
      blocks.delete(blockKey(ev['index']));
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
