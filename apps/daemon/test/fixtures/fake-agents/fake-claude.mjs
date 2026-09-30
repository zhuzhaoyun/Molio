#!/usr/bin/env node
// Fake Claude Code agent for testing.
// Accepts the same CLI flags as Claude Code but ignores stdin content and
// emits a deterministic stream-json response on stdout for each received line.
//
// Supports these modes via environment variables:
//   - default: emit one turn with turn_end/result, then exit (single-turn)
//   - FAKE_CLAUDE_NO_TURN_END=1: emit text_delta but no turn_end/result, keep alive
//   - FAKE_CLAUDE_MULTI_TURN=1: emit turn_end/result each turn, keep stdin open
//   - FAKE_CLAUDE_REAL_STREAM=1: mimic REAL Claude Code stream-json — the
//     `assistant` message block carries `stop_reason: null` (NOT a string), so
//     turn_end must be emitted by the `result` fallback. Used together with
//     FAKE_CLAUDE_MULTI_TURN=1 to reproduce issue #87: without resetting the
//     turn-end guard on message_start, the 2nd turn's result fallback is
//     suppressed and the last assistant reply is never flushed.
//   - FAKE_CLAUDE_API_RETRY=<status>: mimic real Claude Code behavior against a
//     failing provider (captured live from CC 2.1.116 + expired GLM token):
//     emit system/init, then system/api_retry events with exponential backoff
//     and NEVER a result event — the process just keeps retrying. The real CLI
//     burns 10 attempts (~3 min) before giving up; the fake emits attempt 1
//     immediately so tests can assert fast-fail behavior without waiting.
//     Use 401/403 for auth failures, 429/500 for transient-retry behavior.

import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

// Handle --version probe
if (args.includes('--version')) {
  console.log('fake-claude 1.0.0');
  process.exit(0);
}

const NO_TURN_END = process.env['FAKE_CLAUDE_NO_TURN_END'] === '1';
const MULTI_TURN = process.env['FAKE_CLAUDE_MULTI_TURN'] === '1';
// When set to an HTTP status (e.g. "401"), emulate a failing provider: emit
// system/api_retry events with that error_status forever, never a result.
const API_RETRY_STATUS = process.env['FAKE_CLAUDE_API_RETRY']
  ? Number(process.env['FAKE_CLAUDE_API_RETRY'])
  : null;
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

function runApiRetryLoop() {
  // Real Claude Code against a failing provider: init once, then one
  // system/api_retry per attempt with exponential backoff, no result event
  // for minutes. Attempt 1 fires immediately so tests don't wait on backoff.
  emit({ type: 'system', subtype: 'init', model: 'fake-claude' });
  let attempt = 0;
  const tick = () => {
    attempt += 1;
    emit({
      type: 'system',
      subtype: 'api_retry',
      attempt,
      max_retries: 10,
      retry_delay_ms: Math.min(500 * 2 ** (attempt - 1), 33_000),
      error_status: API_RETRY_STATUS,
      // Mirror the real provider error strings (captured live from GLM 401).
      error: API_RETRY_STATUS === 401 || API_RETRY_STATUS === 403
        ? 'authentication_failed'
        : 'overloaded_error',
      session_id: 'fake-session',
    });
    if (attempt < 10) setTimeout(tick, 300);
  };
  tick();
  // Never exits — like the real CLI mid-backoff, stdin stays open.
}

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
  if (API_RETRY_STATUS) {
    if (responded) return;
    responded = true;
    runApiRetryLoop();
    return;
  }
  if (NO_TURN_END && responded) return;
  responded = true;
  runResponse();
  maybeExit();
});

rl.on('close', () => {
  if (responded) return;
  if (API_RETRY_STATUS) return; // process would already be dead; nothing to do
  runResponse();
  maybeExit();
});
