import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStderrChunk } from '../../src/core/runtimes/stderr.js';

/**
 * Error-driven test: Claude Code print-mode stderr diagnostics must not be
 * surfaced as UI errors.
 *
 * Customer report: configuring DeepSeek as the Claude Code provider made
 * every run show the error
 *   [claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}
 * while the same setup worked fine in the user's own cmd.
 *
 * Root cause: Claude Code >= 2.1.233 writes `[claude-code:*]` diagnostics to
 * stderr in print mode (`-p`). `unrecognized_model` fires on every request
 * whose model id isn't a built-in Anthropic id — always the case for
 * third-party providers. The request still goes out; the line is purely
 * informational. Molio's stderr handler emitted it as an `error` event, and
 * the frontend flips the assistant message to streaming:false on error —
 * discarding the real reply that followed.
 *
 * Fix: classifyStderrChunk demotes `[claude-code:*]` lines to `raw` events
 * (logged to events.jsonl, ignored by the UI) while keeping genuine error
 * lines as `error` events.
 */

const CUSTOMER_LINE =
  '[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}';

describe('classifyStderrChunk — claude diagnostics', () => {
  it('reproduces the customer report: unrecognized_model line is NOT an error event', () => {
    const events = classifyStderrChunk('claude', CUSTOMER_LINE + '\n');
    assert.ok(events.length > 0, 'diagnostic should still be persisted as raw');
    for (const ev of events) {
      assert.notEqual(ev.type, 'error', `must not emit error for: ${CUSTOMER_LINE}`);
    }
    assert.deepEqual(events, [{ type: 'raw', line: CUSTOMER_LINE }]);
  });

  it('demotes any [claude-code:*] marker line, not just unrecognized_model', () => {
    const events = classifyStderrChunk('claude', '[claude-code:some_future_kind] details\n');
    assert.deepEqual(events, [{ type: 'raw', line: '[claude-code:some_future_kind] details' }]);
  });

  it('keeps genuine error lines in a mixed chunk as an error event', () => {
    const chunk = `${CUSTOMER_LINE}\nAPI Error: 401 invalid api key\n`;
    const events = classifyStderrChunk('claude', chunk);
    const raws = events.filter((e) => e.type === 'raw');
    const errors = events.filter((e) => e.type === 'error');
    assert.equal(raws.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.type === 'error' && errors[0]!.message, 'API Error: 401 invalid api key');
  });

  it('does not over-filter: marker mentioned mid-line is still an error', () => {
    const events = classifyStderrChunk('claude', 'Failed, see [claude-code:docs] for help\n');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'error');
  });

  it('plain claude stderr without the marker stays an error event', () => {
    const events = classifyStderrChunk('claude', 'Something actually broke\n');
    assert.deepEqual(events, [{ type: 'error', message: 'Something actually broke' }]);
  });

  it('only claude gets the diagnostic demotion — other agents keep error behavior', () => {
    for (const agentId of ['gemini', 'qwen', 'codex', 'unknown']) {
      const events = classifyStderrChunk(agentId, CUSTOMER_LINE + '\n');
      assert.equal(events.length, 1, `agent ${agentId}`);
      assert.equal(events[0]!.type, 'error', `agent ${agentId}`);
    }
  });
});

describe('classifyStderrChunk — existing behavior preserved', () => {
  it('codex informational stderr is still dropped', () => {
    assert.deepEqual(classifyStderrChunk('codex', 'Reading prompt from stdin...\n'), []);
    assert.deepEqual(classifyStderrChunk('codex', 'Reading additional input from stdin...\n'), []);
  });

  it('codex real errors still surface', () => {
    const events = classifyStderrChunk('codex', 'model not found\n');
    assert.deepEqual(events, [{ type: 'error', message: 'model not found' }]);
  });

  it('empty / whitespace-only chunks produce no events', () => {
    assert.deepEqual(classifyStderrChunk('claude', ''), []);
    assert.deepEqual(classifyStderrChunk('claude', '  \n\t '), []);
  });
});
