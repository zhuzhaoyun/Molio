#!/usr/bin/env node
// Fake Claude Code agent for testing.
// Accepts the same CLI flags as Claude Code but ignores stdin content and
// emits a deterministic stream-json response on stdout for each received line.
//
// Supports four modes via environment variables:
//   - default: emit one turn with turn_end/result, then exit (single-turn)
//   - FAKE_CLAUDE_NO_TURN_END=1: emit text_delta but no turn_end/result, keep alive
//   - FAKE_CLAUDE_MULTI_TURN=1: emit turn_end/result each turn, keep stdin open
//   - FAKE_CLAUDE_REAL_STREAM=1: mimic REAL Claude Code stream-json — the
//     `assistant` message block carries `stop_reason: null` (NOT a string), so
//     turn_end must be emitted by the `result` fallback. Used together with
//     FAKE_CLAUDE_MULTI_TURN=1 to reproduce issue #87: without resetting the
//     turn-end guard on message_start, the 2nd turn's result fallback is
//     suppressed and the last assistant reply is never flushed.

import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

// Handle --version probe
if (args.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}

const NO_TURN_END = process.env['FAKE_CLAUDE_NO_TURN_END'] === '1';
const MULTI_TURN = process.env['FAKE_CLAUDE_MULTI_TURN'] === '1';
// In real Claude Code stream-json, assistant message blocks carry stop_reason:
// null during streaming; the real stop_reason only appears on the `result`
// event. When enabled, emit stop_reason: null (matching production) so turn_end
// relies entirely on the result fallback path.
const REAL_STREAM = process.env['FAKE_CLAUDE_REAL_STREAM'] === '1';

function emit(obj) {
  console.log(JSON.stringify(obj));
}

let turnCount = 0;
let responded = false;

function runResponse() {
  turnCount += 1;
  const text = MULTI_TURN ? `Reply #${turnCount}` : 'Hello from fake Claude!';

  if (turnCount === 1) {
    emit({ type: 'system', subtype: 'init', model: 'fake-claude' });
  }

  emit({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: `msg-fake-${turnCount}` } },
  });

  emit({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  });

  if (NO_TURN_END) {
    return;
  }

  emit({
    type: 'assistant',
    message: {
      id: `msg-fake-${turnCount}`,
      content: [{ type: 'text', text }],
      // Real Claude Code streams stop_reason: null on assistant blocks; the
      // terminal stop_reason only arrives on the `result` event.
      stop_reason: REAL_STREAM ? null : 'end_turn',
    },
  });

  emit({
    type: 'result',
    usage: { input_tokens: 10, output_tokens: 23 },
    total_cost_usd: 0.001,
    duration_ms: 150,
  });
}

function maybeExit() {
  if (NO_TURN_END || MULTI_TURN) {
    // Keep process alive for multi-turn / shutdown tests
    return;
  }
  setTimeout(() => process.exit(0), 50);
}

const rl = createInterface({ input: process.stdin });

rl.on('line', () => {
  if (NO_TURN_END && responded) return;
  responded = true;
  runResponse();
  maybeExit();
});

rl.on('close', () => {
  if (responded) return;
  runResponse();
  maybeExit();
});
