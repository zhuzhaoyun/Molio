import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildNavState, buildAskAboutState } from '../../src/hooks/useFileNavigation';

describe('buildNavState — file navigation state builder', () => {
  it('should produce correct nav state from home page', () => {
    const result = buildNavState('vault-1', 'notes/test.md');
    assert.strictEqual(result.route, '/knowledge');
    assert.deepStrictEqual(result.state, { openFile: 'notes/test.md', vaultId: 'vault-1' });
  });

  it('should produce correct nav state from history page', () => {
    const result = buildNavState('vault-2', 'docs/api.md');
    assert.strictEqual(result.route, '/knowledge');
    assert.deepStrictEqual(result.state, { openFile: 'docs/api.md', vaultId: 'vault-2' });
  });

  it('should return null when vaultId is null', () => {
    const result = buildNavState(null, 'notes/test.md');
    assert.strictEqual(result, null);
  });

  it('should produce ask-about-file nav state', () => {
    const result = buildAskAboutState('vault-1', 'notes/test.md');
    assert.strictEqual(result.route, '/');
    assert.deepStrictEqual(result.state, { askAboutFile: 'notes/test.md', vaultId: 'vault-1' });
  });
});
