import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTextCollector } from '../../src/core/turn-text-collector.js';

describe('TurnTextCollector', () => {
  it('should accumulate text and flush on demand', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('Hello ');
    collector.append('world!');
    assert.equal(results.length, 0, 'Should not flush before explicit flush()');

    const flushed = collector.flush();
    assert.equal(flushed, true);
    assert.equal(results.length, 1);
    assert.equal(results[0], 'Hello world!');
  });

  it('should trim whitespace on flush', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('  \n padded content \n  ');
    collector.flush();
    assert.equal(results[0], 'padded content');
  });

  it('should return false and skip callback for empty buffer', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    const flushed = collector.flush();
    assert.equal(flushed, false);
    assert.equal(results.length, 0);
  });

  it('should return false and skip callback for whitespace-only buffer', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('   \n  ');
    const flushed = collector.flush();
    assert.equal(flushed, false);
    assert.equal(results.length, 0);
  });

  it('should be idempotent — second flush returns false', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('text');
    assert.equal(collector.flush(), true);
    assert.equal(collector.flush(), false);
    assert.equal(results.length, 1);
  });

  it('should support multiple turns: flush → append → flush', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    // Turn 1
    collector.append('First reply');
    collector.flush();
    assert.equal(results.length, 1);
    assert.equal(results[0], 'First reply');

    // Turn 2
    collector.append('Second reply');
    collector.flush();
    assert.equal(results.length, 2);
    assert.equal(results[1], 'Second reply');
  });

  it('should swallow callback errors and still clear buffer', () => {
    const collector = new TurnTextCollector('run-1', () => { throw new Error('DB write failed'); });

    collector.append('text');
    assert.doesNotThrow(() => collector.flush());

    // Buffer should be cleared despite error
    const results: string[] = [];
    // Replace with a working callback to verify buffer is empty
    // (We can't replace callback, but we can verify flush returns false)
    assert.equal(collector.flush(), false, 'Buffer should be empty after error-flush');
  });

  it('should clear buffer silently when callback is null', () => {
    const collector = new TurnTextCollector('run-1');

    collector.append('orphan text');
    const flushed = collector.flush();
    assert.equal(flushed, false);

    // Verify buffer is cleared
    assert.equal(collector.flush(), false);
  });

  it('should discard text on reset without invoking callback', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('will be discarded');
    collector.reset();
    assert.equal(results.length, 0);

    // Verify buffer is cleared
    assert.equal(collector.flush(), false);
  });

  it('should accumulate fresh text after reset', () => {
    const results: string[] = [];
    const collector = new TurnTextCollector('run-1', (text) => { results.push(text); });

    collector.append('old text');
    collector.reset();
    collector.append('new text');
    collector.flush();
    assert.equal(results.length, 1);
    assert.equal(results[0], 'new text');
  });

  it('should pass runId to callback', () => {
    let capturedRunId: string | null = null;
    const collector = new TurnTextCollector('my-run-123', (_text, _tools, runId) => { capturedRunId = runId; });

    collector.append('test');
    collector.flush();
    assert.equal(capturedRunId, 'my-run-123');
  });

  /**
   * Regression test for PR #75: multi-turn message ordering.
   *
   * When a user sends a new message while the assistant is still replying,
   * the pending assistant reply must be flushed BEFORE the user message
   * is inserted into the DB. This ensures position ordering matches the
   * actual conversation order (assistant reply < next user message).
   *
   * Simulates the sequence:
   *   1. Assistant accumulates text (partial reply)
   *   2. User sends new message → flushPendingReply() called first
   *   3. User message inserted
   *   4. New assistant reply starts accumulating
   */
  it('should flush pending reply before new user message to preserve ordering', () => {
    const persisted: Array<{ role: string; content: string; order: number }> = [];
    let orderCounter = 0;

    const collector = new TurnTextCollector('run-1', (text) => {
      persisted.push({ role: 'assistant', content: text, order: ++orderCounter });
    });

    // Turn 1: Assistant starts replying
    collector.append('Assistant reply part 1... ');
    collector.append('Assistant reply part 2.');

    // User sends new message — flushPendingReply() should be called BEFORE
    // inserting the user message. Simulate this by flushing now.
    const flushed = collector.flush();
    assert.equal(flushed, true, 'Should flush pending assistant reply');

    // Now user message would be inserted (simulated)
    persisted.push({ role: 'user', content: 'New user message', order: ++orderCounter });

    // Turn 2: Assistant starts replying to the new message
    collector.append('Second assistant reply.');
    collector.flush();

    // Verify ordering: assistant1 < user2 < assistant2
    assert.equal(persisted.length, 3);
    assert.equal(persisted[0]!.role, 'assistant');
    assert.equal(persisted[0]!.content, 'Assistant reply part 1... Assistant reply part 2.');
    assert.equal(persisted[0]!.order, 1);

    assert.equal(persisted[1]!.role, 'user');
    assert.equal(persisted[1]!.content, 'New user message');
    assert.equal(persisted[1]!.order, 2);

    assert.equal(persisted[2]!.role, 'assistant');
    assert.equal(persisted[2]!.content, 'Second assistant reply.');
    assert.equal(persisted[2]!.order, 3);
  });
});
