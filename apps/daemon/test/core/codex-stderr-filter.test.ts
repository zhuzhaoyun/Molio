import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@molio/contracts';

/**
 * Error-driven test: Codex stderr informational message filtering.
 *
 * Bug (Issue #55): Codex CLI logs "Reading prompt from stdin..." and
 * "Reading additional input from stdin..." to stderr as informational
 * messages, not errors. Molio's stderr handler mistakenly treated them
 * as error events, causing red error bubbles in the UI.
 *
 * Fix: In RunManager.createRun, filter out known Codex informational
 * stderr messages before emitting them as error events.
 */

interface RuntimeDefStub {
  id: string;
}

interface RunStateStub {
  events: AgentEvent[];
}

/**
 * Simulate the stderr filtering logic from RunManager.createRun.
 */
function simulateStderrFilter(
  def: RuntimeDefStub,
  chunk: string,
): AgentEvent | null {
  const trimmed = chunk.trim();
  const isCodexInfoStderr = def.id === 'codex' && (
    trimmed.includes('Reading prompt from stdin') ||
    trimmed.includes('Reading additional input from stdin')
  );
  if (trimmed && !isCodexInfoStderr) {
    return { type: 'error', message: trimmed };
  }
  return null;
}

describe('Codex stderr filter', () => {
  it('should filter "Reading prompt from stdin..." for codex agent', () => {
    const def: RuntimeDefStub = { id: 'codex' };
    const result = simulateStderrFilter(def, 'Reading prompt from stdin...\n');
    assert.equal(result, null);
  });

  it('should filter "Reading additional input from stdin..." for codex agent', () => {
    const def: RuntimeDefStub = { id: 'codex' };
    const result = simulateStderrFilter(def, 'Reading additional input from stdin...\n');
    assert.equal(result, null);
  });

  it('should NOT filter the same messages for non-codex agents', () => {
    const agents = ['claude', 'gemini', 'qwen', 'unknown'];
    for (const id of agents) {
      const def: RuntimeDefStub = { id };
      const result1 = simulateStderrFilter(def, 'Reading prompt from stdin...\n');
      assert.ok(result1 !== null, `Expected ${id} to NOT filter "Reading prompt from stdin"`);
      assert.equal(result1!.type, 'error');

      const result2 = simulateStderrFilter(def, 'Reading additional input from stdin...\n');
      assert.ok(result2 !== null, `Expected ${id} to NOT filter "Reading additional input from stdin"`);
      assert.equal(result2!.type, 'error');
    }
  });

  it('should emit other stderr messages as errors for codex', () => {
    const def: RuntimeDefStub = { id: 'codex' };
    const result = simulateStderrFilter(def, 'Some actual error message\n');
    assert.ok(result !== null);
    assert.equal(result!.type, 'error');
    assert.equal(result!.message, 'Some actual error message');
  });

  it('should handle empty stderr chunks gracefully', () => {
    const def: RuntimeDefStub = { id: 'codex' };
    const result = simulateStderrFilter(def, '   \n\t   ');
    assert.equal(result, null);
  });

  it('should handle partial matches correctly (not over-filter)', () => {
    const def: RuntimeDefStub = { id: 'codex' };
    // A message that contains "stdin" but is NOT the known Codex message
    const result = simulateStderrFilter(def, 'Failed to read from stdin: permission denied\n');
    assert.ok(result !== null);
    assert.equal(result!.type, 'error');
    assert.ok(result!.message.includes('Failed to read from stdin'));
  });
});
