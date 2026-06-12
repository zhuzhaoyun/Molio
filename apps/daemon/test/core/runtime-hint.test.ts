import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeHint } from '../../src/core/RunManager.js';
import type { RuntimeAgentDef } from '@molio/contracts';

function makeDef(overrides: Partial<RuntimeAgentDef>): RuntimeAgentDef {
  return {
    id: 'test',
    name: 'Test Agent',
    bin: 'test-bin',
    versionArgs: ['--version'],
    buildArgs: () => [],
    streamFormat: 'text',
    fallbackModels: [],
    ...overrides,
  };
}

describe('buildRuntimeHint', () => {
  it('should include agent name and id in system-hint tags', () => {
    const def = makeDef({ id: 'qwen', name: 'Qwen Code' });
    const hint = buildRuntimeHint(def);

    assert.ok(hint.includes('<system-hint>'));
    assert.ok(hint.includes('</system-hint>'));
    assert.ok(hint.includes('Qwen Code'));
    assert.ok(hint.includes('qwen'));
  });

  it('should produce correct format for claude agent', () => {
    const def = makeDef({ id: 'claude', name: 'Claude Code' });
    const hint = buildRuntimeHint(def);

    assert.equal(
      hint,
      '<system-hint>You are running as "Claude Code" (id: claude) inside Molio. When the user asks which AI runtime or agent is active, tell them this.</system-hint>\n\n',
    );
  });

  it('should produce correct format for codex agent', () => {
    const def = makeDef({ id: 'codex', name: 'Codex CLI' });
    const hint = buildRuntimeHint(def);

    assert.ok(hint.includes('"Codex CLI"'));
    assert.ok(hint.includes('(id: codex)'));
  });

  it('should end with double newline for clean message separation', () => {
    const def = makeDef({ id: 'gemini', name: 'Gemini CLI' });
    const hint = buildRuntimeHint(def);

    assert.ok(hint.endsWith('\n\n'));
  });

  it('should instruct agent to report its runtime when asked', () => {
    const def = makeDef({ id: 'qwen', name: 'Qwen Code' });
    const hint = buildRuntimeHint(def);

    assert.ok(hint.includes('When the user asks which AI runtime or agent is active'));
  });
});
