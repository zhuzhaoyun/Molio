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
 * --append-system-prompt-FILE, not inline --append-system-prompt text.
 *
 * Bug 1 (placement): buildWeixinRunMessage / runs.ts used to prepend
 * WIKI_*_PROMPT into the user message, role-locking the agent into a
 * prescribed retrieval path and suppressing native retrieval. Fix: pass the
 * frame as the agent's system prompt.
 *
 * Bug 2 (inline arg breaks flags): the wiki frame is multi-KB with embedded
 * quotes/backticks/backslashes (e.g. `node "<skill_dir>/extract.js"`,
 * `<attach path="D:\\..."/>`). Passing it inline as `--append-system-prompt
 * <text>` broke the CLI's argv parsing on Windows and silently dropped later
 * flags — notably `--dangerously-skip-permissions` — so every Bash tool call
 * came back "This command requires approval" and ingestion couldn't run
 * wechat-article-extractor. Reproduced: desktop (smaller QUERY frame) bash
 * executed; weixin (4.9KB WEIXIN frame) bash blocked; same daemon/code/model.
 * Fix: materialize the frame to a temp file and pass `--append-system-prompt-
 * file <path>` — a plain path arg has no parsing pitfalls.
 */
describe('Claude runtime append-system-prompt-file', () => {
  it('passes appendSystemPromptFile via --append-system-prompt-file when set', () => {
    const args = claudeAgentDef.buildArgs('clean user message', {
      appendSystemPromptFile: 'C:/tmp/molio-sysprompt-abc123.txt',
    });
    const idx = args.indexOf('--append-system-prompt-file');
    assert.ok(idx >= 0, 'should include --append-system-prompt-file');
    assert.equal(
      args[idx + 1],
      'C:/tmp/molio-sysprompt-abc123.txt',
      'the file path should follow the flag verbatim',
    );
    // The user message is NOT mangled into the args (claude -p reads it via
    // stdin stream-json, not as a positional arg).
    assert.ok(
      !args.some((a) => a.includes('clean user message')),
      'user message must not leak into argv',
    );
    // --dangerously-skip-permissions survives AFTER the file-path arg.
    assert.ok(
      args.includes('--dangerously-skip-permissions'),
      '--dangerously-skip-permissions must still be present (regression: inline text ate it)',
    );
  });

  it('omits --append-system-prompt-file when appendSystemPromptFile is unset', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    assert.ok(
      !args.includes('--append-system-prompt-file'),
      'should not add the flag when no file is provided',
    );
  });
});
