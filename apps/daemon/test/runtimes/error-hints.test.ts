import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentErrorHint } from '../../src/core/runtimes/error-hints.js';

/**
 * Error-driven tests: on a real machine (2026-10-04), a dsh run without
 * DEEPSEEK_API_KEY failed with dsh's own advice — "store DEEPSEEK_API_KEY
 * through the credentials service (the web Models page writes it)" — concepts
 * that don't exist in Molio. Non-technical users can't act on that, so
 * RunManager appends a Molio-actionable hint via agentErrorHint().
 */
describe('agentErrorHint', () => {
  // Verbatim production text (dsh 0.2.0-rc.2 → ACP -32603 on session/prompt),
  // wrapped the way AcpTransport rejects it.
  const REAL_DSH_ERROR =
    'ACP error -32603: Internal error: turn failed: llm-deepseek: no API key '
    + 'for provider route "deepseek-official"; store DEEPSEEK_API_KEY through '
    + 'the credentials service (the web Models page writes it), or export '
    + 'DEEPSEEK_API_KEY in the launching environment';

  it('dsh missing-API-key error gets a Molio-actionable hint', () => {
    const hint = agentErrorHint('dsh', REAL_DSH_ERROR);
    assert.ok(hint, 'must return a hint for the real production error text');
    // The hint must name Molio's actual fix path (设置 → 运行时 → card → 配置)
    // and where to obtain a key — NOT dsh's credentials service / Models page.
    assert.match(hint, /设置/);
    assert.match(hint, /运行时/);
    assert.match(hint, /DeepSeek Harness/);
    assert.match(hint, /API Key/);
    assert.match(hint, /platform\.deepseek\.com\/api_keys/);
    // Must not parrot dsh-internal concepts that don't exist in Molio.
    assert.doesNotMatch(hint, /credentials service/);
    assert.doesNotMatch(hint, /Models page/);
  });

  it('matches custom-provider routes too (not just deepseek-official)', () => {
    const customRoute = REAL_DSH_ERROR.replace('deepseek-official', 'custom-1');
    assert.ok(
      agentErrorHint('dsh', customRoute),
      'the pattern must key on "no API key", not the provider-route name',
    );
  });

  it('unrelated dsh errors get no hint', () => {
    assert.equal(agentErrorHint('dsh', 'ACP idle timeout: initialize (no activity for 60000ms)'), null);
    assert.equal(agentErrorHint('dsh', 'dsh process exited with code 1'), null);
    assert.equal(agentErrorHint('dsh', ''), null);
  });

  it('rules are scoped per agent — dsh patterns never leak to other runtimes', () => {
    assert.equal(agentErrorHint('hermes', REAL_DSH_ERROR), null);
    assert.equal(agentErrorHint('claude', REAL_DSH_ERROR), null);
    assert.equal(agentErrorHint('unknown-agent', REAL_DSH_ERROR), null);
  });
});
