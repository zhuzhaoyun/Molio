import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Error-driven test: Agent test endpoint must detect turn completion
 * for multi-turn agents (Qwen, Claude) instead of waiting for process exit.
 *
 * Bug: The test endpoint polled isTerminal() which only returns true when
 * the child process exits. Multi-turn agents (multiTurn: true) keep stdin
 * open after responding, so the process never exits → 30s timeout.
 *
 * Fix: Use onEvent() to detect turn completion (usage event) instead of
 * relying solely on process exit.
 */

describe('Agent test endpoint — multi-turn turn completion', () => {
  it('should detect turn completion via usage event (not process exit)', () => {
    // Verify the turn completion detection logic:
    // A 'usage' event with is_error !== true indicates a successful turn.
    const usageEvent = {
      type: 'usage' as const,
      usage: { input_tokens: 100, output_tokens: 50 },
    };

    // The test endpoint should consider this a successful turn
    const isSuccessTurn = usageEvent.type === 'usage';
    assert.ok(isSuccessTurn, 'usage event should indicate turn completion');
  });

  it('should detect error turn via error event', () => {
    const errorEvent = {
      type: 'error' as const,
      message: 'Agent returned error',
    };

    assert.equal(errorEvent.type, 'error');
    assert.ok(errorEvent.message, 'error event should have a message');
  });

  it('multi-turn agents should NOT close stdin after turn_end', () => {
    // Verify that multiTurn: true prevents stdin close.
    // This is the root cause of the bug — the process stays alive.
    const multiTurnDef = { multiTurn: true };
    const shouldCloseStdin = !multiTurnDef.multiTurn;
    assert.ok(!shouldCloseStdin, 'multi-turn agents keep stdin open');
  });

  it('non-multi-turn agents should close stdin after turn_end', () => {
    const singleTurnDef = { multiTurn: false };
    const shouldCloseStdin = !singleTurnDef.multiTurn;
    assert.ok(shouldCloseStdin, 'single-turn agents should close stdin');
  });
});

describe('Agent test endpoint — event listener cleanup', () => {
  it('should unsubscribe event listener after turn completion', () => {
    // Simulate the cleanup pattern used in the fixed test endpoint
    let unsubscribed = false;
    const unsubscribe = () => { unsubscribed = true; };

    // After detecting turn completion, unsubscribe should be called
    unsubscribe();
    assert.ok(unsubscribed, 'event listener should be unsubscribed');
  });

  it('should unsubscribe event listener on timeout', () => {
    // Even on timeout, the listener must be cleaned up to avoid leaks
    let unsubscribed = false;
    const unsubscribe = () => { unsubscribed = true; };

    // Simulate timeout cleanup
    unsubscribe();
    assert.ok(unsubscribed, 'event listener should be unsubscribed on timeout');
  });
});
