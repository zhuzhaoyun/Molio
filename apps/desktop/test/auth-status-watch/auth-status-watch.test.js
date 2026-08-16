/**
 * auth-status-watch.js 行为级测试：mock globalThis.fetch（同 daemon-metrics
 * 测试模式），驱动登录/登出/daemon 宕机三种状态转换。
 *
 * 关键红线：
 * - userId 只在变化时触发 onUser（不重复上报）
 * - daemon 不可达 ≠ 登出（绝不因请求失败触发 onUser(null)）
 * - 慢响应不堆叠请求（in-flight 守卫）；stop() 中止在途请求
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startAuthStatusPolling, resolveIntervalMs } from '../../src/auth-status-watch.js';

// 注入快间隔绕过 1s 生产下限（同 daemon-metrics 测试）。
const FAST_INTERVAL = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusResponse(status) {
  return {
    ok: true,
    json: async () => status,
  };
}

const LOGGED_IN = { loggedIn: true, configured: true, user: { id: '01HXYZUSER', email: 'a@b.c' }, stale: false };
const LOGGED_OUT = { loggedIn: false, configured: true };

describe('resolveIntervalMs', () => {
  it('accepts values at/above the 1s floor', () => {
    assert.equal(resolveIntervalMs('1000'), 1000);
    assert.equal(resolveIntervalMs('30000'), 30000);
  });

  it('falls back to 15s default for sub-floor/negative/non-numeric', () => {
    assert.equal(resolveIntervalMs('-1'), 15_000);
    assert.equal(resolveIntervalMs('0'), 15_000);
    assert.equal(resolveIntervalMs('999'), 15_000);
    assert.equal(resolveIntervalMs('abc'), 15_000);
    assert.equal(resolveIntervalMs(undefined), 15_000);
    assert.equal(resolveIntervalMs('Infinity'), 15_000);
  });
});

describe('startAuthStatusPolling', () => {
  let stop = null;
  let origFetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (stop) { stop(); stop = null; }
    globalThis.fetch = origFetch;
  });

  it('detects logged-in user and fires onUser with the userId (not email)', async () => {
    globalThis.fetch = async () => statusResponse(LOGGED_IN);
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    assert.deepEqual(seen, ['01HXYZUSER'], 'fires exactly once with ULID');
  });

  it('does not re-fire while the user stays the same', async () => {
    globalThis.fetch = async () => statusResponse(LOGGED_IN);
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(150); // 至少 4 次轮询
    assert.equal(seen.length, 1, 'only the first transition fires');
  });

  it('login → logout transition fires onUser(null)', async () => {
    let loggedIn = true;
    globalThis.fetch = async () => statusResponse(loggedIn ? LOGGED_IN : LOGGED_OUT);
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    loggedIn = false;
    await sleep(120);
    assert.deepEqual(seen, ['01HXYZUSER', null]);
  });

  it('logout → re-login (account switch) fires the new userId', async () => {
    let userId = null;
    globalThis.fetch = async () =>
      statusResponse(userId ? { loggedIn: true, user: { id: userId } } : LOGGED_OUT);
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80); // 初始未登录 → 与 lastUserId(null) 相同，不触发
    assert.deepEqual(seen, []);
    userId = '01NEWUSER';
    await sleep(120);
    assert.deepEqual(seen, ['01NEWUSER']);
  });

  it('daemon unreachable → silent, does NOT misread as logout', async () => {
    let down = false;
    globalThis.fetch = async () => {
      if (down) throw new Error('ECONNREFUSED');
      return statusResponse(LOGGED_IN);
    };
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    down = true;
    await sleep(120); // 多轮失败期间不触发任何 onUser
    assert.deepEqual(seen, ['01HXYZUSER'], 'failure preserves last state');
    down = false;
    await sleep(120); // 恢复后仍是同一用户 → 不重复触发
    assert.deepEqual(seen, ['01HXYZUSER']);
  });

  it('non-200 / malformed responses are ignored', async () => {
    let phase = 0;
    globalThis.fetch = async () => {
      if (phase === 0) return { ok: false, status: 500 };
      if (phase === 1) {
        // 模拟坏 JSON：res.json() reject（与真实 fetch 行为一致）
        return { ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } };
      }
      return statusResponse(LOGGED_IN);
    };
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    phase = 1;
    await sleep(80);
    assert.deepEqual(seen, [], 'bad responses never change state');
    phase = 2;
    await sleep(120);
    assert.deepEqual(seen, ['01HXYZUSER']);
  });

  it('valid JSON with malformed shape must NOT be downgraded to logout', async () => {
    // Regression: 坏形状快照（{}、loggedIn:true 缺 user.id）曾让 userId 落回 null，
    // 上一轮已登录时会触发 onUser(null) —— 把"响应坏掉"误判成"用户登出"。
    // 红线：只有明确的 loggedIn === false 才构成登出转换。
    const malformedShapes = [{}, { loggedIn: true }, { loggedIn: true, user: { id: 42 } }, 'str'];
    for (const malformed of malformedShapes) {
      let phase = 0;
      globalThis.fetch = async () => statusResponse(phase === 0 ? LOGGED_IN : malformed);
      const seen = [];
      stop = startAuthStatusPolling({
        daemonPort: 3100,
        onUser: (id) => seen.push(id),
        log: () => {},
        intervalMs: FAST_INTERVAL,
      });
      await sleep(80);
      phase = 1;
      await sleep(150); // 多轮坏响应期间不得出现 null 转换
      assert.deepEqual(seen, ['01HXYZUSER'], `shape ${JSON.stringify(malformed)} must preserve last state`);
      stop();
      stop = null;
    }
  });

  it('definitive loggedIn:false after malformed shape still fires logout', async () => {
    let phase = 0;
    globalThis.fetch = async () =>
      statusResponse(phase === 0 ? LOGGED_IN : phase === 1 ? {} : LOGGED_OUT);
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    phase = 1;
    await sleep(120); // 坏形状：保持登录态
    assert.deepEqual(seen, ['01HXYZUSER']);
    phase = 2;
    await sleep(120); // 明确登出：触发 null
    assert.deepEqual(seen, ['01HXYZUSER', null]);
  });

  it('stop() halts polling', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return statusResponse(LOGGED_OUT);
    };
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: () => {},
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80);
    stop();
    stop = null;
    const countAtStop = fetchCount;
    await sleep(120);
    assert.equal(fetchCount, countAtStop, 'no more fetches after stop()');
  });

  it('上一轮未返回 → 后续轮次跳过（请求不堆叠）', async () => {
    // daemon 响应慢于轮询间隔时，in-flight 守卫保证任意时刻至多一个在途请求，
    // 否则快间隔 + 慢响应会线性堆叠请求直到 daemon 雪崩。
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let inFlightNow = 0;
    let inFlightMax = 0;
    globalThis.fetch = async (_url, opts) => {
      inFlightNow += 1;
      inFlightMax = Math.max(inFlightMax, inFlightNow);
      try {
        await new Promise((resolve, reject) => {
          gate.then(resolve);
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        return statusResponse(LOGGED_IN);
      } finally {
        inFlightNow -= 1;
      }
    };
    const seen = [];
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => seen.push(id),
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(150); // 首轮挂起期间已有多次 tick 被跳过
    assert.equal(inFlightMax, 1, '任意时刻至多一个在途请求');
    release();
    await sleep(120);
    assert.deepEqual(seen, ['01HXYZUSER'], '挂起请求返回后正常触发一次');
  });

  it('stop() 中止在途请求（不只是清定时器）', async () => {
    let seenSignal = null;
    globalThis.fetch = async (_url, opts) => {
      seenSignal = opts?.signal ?? null;
      return new Promise((_resolve, reject) => {
        // 永不自然返回，只有 abort 能终结——模拟退出瞬间 daemon 无响应
        seenSignal?.addEventListener('abort', () => reject(new Error('AbortError')));
      });
    };
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: () => {},
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    await sleep(80); // 首轮 poll 已发出
    assert.ok(seenSignal, 'fetch 必须携带 signal');
    assert.equal(seenSignal.aborted, false, 'stop 前 signal 未中止');
    stop();
    stop = null;
    assert.equal(seenSignal.aborted, true, 'stop() 立即中止在途 signal');
  });

  it('onUser throwing does not kill the poller', async () => {
    let loggedIn = false;
    globalThis.fetch = async () => statusResponse(loggedIn ? LOGGED_IN : LOGGED_OUT);
    const seen = [];
    let throwOnce = true;
    stop = startAuthStatusPolling({
      daemonPort: 3100,
      onUser: (id) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('callback bug');
        }
        seen.push(id);
      },
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });
    loggedIn = true;
    await sleep(80); // 第一次触发抛错（lastUserId 已更新，不重发）
    assert.deepEqual(seen, []);
    loggedIn = false;
    await sleep(120); // 登出转换证明 poller 仍活着
    assert.deepEqual(seen, [null]);
  });
});
