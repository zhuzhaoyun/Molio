import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAgentDef } from '../../src/core/runtimes/claude.js';

/**
 * Error-driven test: Claude Code must use --dangerously-skip-permissions.
 *
 * Bug (issue #68): With --permission-mode acceptEdits + --allowedTools,
 * certain Bash commands (e.g. pip install) still trigger permission prompts
 * that only appear in the terminal — the Web UI has no interactive buttons.
 * Fix: Use --dangerously-skip-permissions to bypass all permission checks.
 */

describe('Claude runtime permission mode', () => {
  it('should use --dangerously-skip-permissions', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(
      args.includes('--dangerously-skip-permissions'),
      'should include --dangerously-skip-permissions flag',
    );
  });

  it('should NOT use --permission-mode (replaced by dangerously-skip-permissions)', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(
      !args.includes('--permission-mode'),
      '--permission-mode should not be present when using --dangerously-skip-permissions',
    );
  });

  it('should NOT use --allowedTools (replaced by dangerously-skip-permissions)', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(
      !args.includes('--allowedTools'),
      '--allowedTools should not be present when using --dangerously-skip-permissions',
    );
  });
});

