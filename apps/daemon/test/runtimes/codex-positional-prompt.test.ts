import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codexAgentDef } from '../../src/core/runtimes/codex.js';

/**
 * Error-driven test: Codex CLI runtime must pass prompt via stdin.
 *
 * Bug: On Windows, codex exec reads prompt from stdin. If stdin is closed
 * too early or if prompt is passed via args, codex throws errors about
 * reading from stdin.
 *
 * Fix: Keep promptViaStdin true so RunManager writes the prompt to stdin
 * via child.stdin.end(prompt). Codex CLI reads the full prompt before
 * the pipe closes.
 */

describe('Codex CLI runtime stdin prompt', () => {
  it('should use promptViaStdin true', () => {
    assert.equal(
      codexAgentDef.promptViaStdin,
      true,
      'promptViaStdin must be true so RunManager writes prompt to child.stdin',
    );
  });

  it('should include exec subcommand and --json flag', () => {
    const args = codexAgentDef.buildArgs('test', {}, {});
    assert.ok(args.includes('exec'), 'should have exec subcommand');
    assert.ok(args.includes('--json'), 'should have --json flag');
  });

  it('should add --model flag when model is specified', () => {
    const args = codexAgentDef.buildArgs('test', { model: 'o3' }, {});
    const idx = args.indexOf('--model');
    assert.ok(idx !== -1, 'should have --model flag');
    assert.equal(args[idx + 1], 'o3');
  });

  it('should NOT append prompt to buildArgs', () => {
    const args = codexAgentDef.buildArgs('hello world', {}, {});
    const promptIdx = args.indexOf('hello world');
    assert.equal(promptIdx, -1, 'prompt should NOT be in buildArgs — it is passed via stdin');
  });
});
