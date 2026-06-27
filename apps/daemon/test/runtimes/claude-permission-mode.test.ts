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

/**
 * Error-driven test: wiki/vault role frame must travel via
 * --append-system-prompt, NOT prepended to the user message.
 *
 * Bug: buildWeixinRunMessage / runs.ts used to prepend WIKI_*_PROMPT into the
 * user message text, which role-locked the agent into a prescribed retrieval
 * path (read hot.md → INDEX.md → wiki pages) and suppressed native retrieval
 * (git log --since=today, find -newermt). Verified by A/B/C probes: with the
 * frame prepended to the user message, "总结今天的工作" only read hot.md/log.md;
 * with it as --append-system-prompt, the agent used git+filesystem and produced
 * a complete summary. Fix: pass the frame as the agent's system prompt.
 */
describe('Claude runtime append-system-prompt', () => {
  it('passes appendSystemPrompt via --append-system-prompt when set', () => {
    const args = claudeAgentDef.buildArgs('clean user message', {
      appendSystemPrompt: '你是一个本地知识库的微信入口助手。',
    });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx >= 0, 'should include --append-system-prompt');
    assert.equal(
      args[idx + 1],
      '你是一个本地知识库的微信入口助手。',
      'the frame text should follow the flag verbatim',
    );
    // The user message is NOT mangled into the args (claude -p reads it via
    // stdin stream-json, not as a positional arg).
    assert.ok(
      !args.some((a) => a.includes('clean user message')),
      'user message must not leak into argv',
    );
  });

  it('omits --append-system-prompt when appendSystemPrompt is unset', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(
      !args.includes('--append-system-prompt'),
      'should not add --append-system-prompt when no frame is provided',
    );
  });
});
