/**
 * idleTimeoutMessage — idle-fallback copy must name the RIGHT broken layer.
 *
 * Error-driven test (2026-10-22 wiki-ingest incident): a qwen3.8-max run hung
 * on a dead provider request for 20+ min. The daemon was healthy — its SSE
 * keepalive pings flowed the whole time — yet the 10-min idle fallback told
 * the user 「响应超时，请重试或检查 daemon 是否运行」, sending them to debug the
 * wrong process. The fallback message is now chosen by ping recency:
 *   - ping within the liveness window → model/provider unresponsive;
 *   - no recent ping → daemon unreachable (the original copy).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { buildIdleFallbackMessage, DAEMON_PING_LIVENESS_MS } = await import(
  '../src/hooks/idleTimeoutMessage.ts'
);

describe('buildIdleFallbackMessage', () => {
  const NOW = 1_800_000_000_000;

  it('blames the model when keepalive pings prove the daemon is alive', () => {
    // Ping arrived 15s ago (the daemon's ping interval) — daemon reachable,
    // so the 10-min event silence is upstream of it.
    const msg = buildIdleFallbackMessage(NOW - 15_000, NOW);
    assert.match(msg, /模型长时间无响应/);
    assert.ok(!msg.includes('检查 daemon'), 'must NOT tell the user to check a healthy daemon');
  });

  it('blames the daemon when no ping arrived within the liveness window', () => {
    const msg = buildIdleFallbackMessage(NOW - DAEMON_PING_LIVENESS_MS - 1, NOW);
    assert.match(msg, /响应超时/);
    assert.match(msg, /daemon/);
  });

  it('blames the daemon when the connection never received a ping', () => {
    // lastKeepaliveAt = null: subscribed but silent from the start (daemon
    // crashed before its first ping, or a blackholed connection).
    const msg = buildIdleFallbackMessage(null, NOW);
    assert.match(msg, /响应超时/);
  });

  it('treats a ping exactly at the liveness boundary as stale', () => {
    const msg = buildIdleFallbackMessage(NOW - DAEMON_PING_LIVENESS_MS, NOW);
    assert.match(msg, /响应超时/);
  });
});
