import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAgentDef } from '../src/core/runtimes/claude.js';

/**
 * Error-driven test: AskUserQuestion must not be auto-confirmed.
 *
 * Bug: --permission-mode bypassPermissions causes the Claude CLI to
 * auto-answer AskUserQuestion before the user has a chance to respond.
 * The fix is to use acceptEdits + --allowedTools for autonomous tools,
 * leaving AskUserQuestion interactive.
 */

describe('Claude runtime permission mode', () => {
  it('should NOT use bypassPermissions (auto-confirms AskUserQuestion)', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    const permIdx = args.indexOf('--permission-mode');
    assert.ok(permIdx !== -1, 'should have --permission-mode flag');
    const mode = args[permIdx + 1];
    assert.notEqual(mode, 'bypassPermissions',
      'bypassPermissions auto-answers AskUserQuestion — use acceptEdits + allowedTools instead');
  });

  it('should use acceptEdits permission mode', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    const permIdx = args.indexOf('--permission-mode');
    assert.ok(permIdx !== -1, 'should have --permission-mode flag');
    assert.equal(args[permIdx + 1], 'acceptEdits');
  });

  it('should include --allowedTools for autonomous operation', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    const toolsIdx = args.indexOf('--allowedTools');
    assert.ok(toolsIdx !== -1, 'should have --allowedTools flag');
    // The tools following --allowedTools should include common autonomous tools
    const toolsStr = args.slice(toolsIdx + 1).join(' ');
    assert.ok(toolsStr.includes('Bash'), 'should allow Bash');
    assert.ok(toolsStr.includes('Edit'), 'should allow Edit');
    assert.ok(toolsStr.includes('Write'), 'should allow Write');
  });

  it('should NOT include AskUserQuestion in allowedTools', () => {
    const args = claudeAgentDef.buildArgs('test prompt', {}, {});
    const toolsIdx = args.indexOf('--allowedTools');
    assert.ok(toolsIdx !== -1, 'should have --allowedTools flag');
    // Collect all args after --allowedTools until the next flag (starts with -)
    const tools: string[] = [];
    for (let i = toolsIdx + 1; i < args.length; i++) {
      if (args[i]!.startsWith('-')) break;
      tools.push(args[i]!);
    }
    const toolsStr = tools.join(' ');
    assert.ok(!toolsStr.includes('AskUserQuestion'),
      'AskUserQuestion must NOT be in allowedTools — it needs user interaction');
  });
});
