import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentEvent } from '@molio/contracts';
import { AcpPool, classifyAcpStderrLine, type AcpSpawnSpec } from '../../src/core/streams/acp-pool.js';

/**
 * AcpPool integration tests — driven by the same fake hermes ACP server the
 * RunManager integration tests use, with the same platform split (win32 uses
 * the .cmd shim + shell:true because windowsVerbatimArguments can't quote an
 * execPath containing spaces; POSIX spawns the shebang'd .mjs directly).
 * Fixtures live in the SOURCE tree (tsc doesn't copy .mjs into dist) — resolve
 * from process.cwd() like hermes-acp-integration.test.ts does (tests run from
 * apps/daemon).
 */

const IS_WIN = process.platform === 'win32';
const FAKE_HERMES = path.join(
  process.cwd(),
  'test', 'fixtures', 'fake-agents',
  IS_WIN ? 'fake-hermes-acp.cmd' : 'fake-hermes-acp.mjs',
);

function makeSpec(overrides: Partial<AcpSpawnSpec> & { envFlags?: Record<string, string> } = {}): AcpSpawnSpec {
  const { envFlags, ...rest } = overrides;
  return {
    agentId: 'hermes',
    binary: FAKE_HERMES,
    args: [],
    env: { ...process.env, ...(envFlags ?? {}) } as NodeJS.ProcessEnv,
    cwd: os.tmpdir(),
    shell: IS_WIN,
    fingerprint: 'fp-default',
    idleTimeoutMs: 3000,
    absoluteTimeoutMs: 10000,
    ...rest,
  };
}

/** Create a real ACP session on an entry and attach it to the pool. */
async function createAndAttach(
  pool: AcpPool,
  entry: Awaited<ReturnType<AcpPool['acquire']>>,
  opts: { idleTimeoutMs?: number; sessionIdScope?: boolean } = {},
) {
  const session: any = await entry.transport.request(
    'session/new',
    { mcpServers: [], cwd: os.tmpdir() },
    { idleTimeoutMs: 3000, absoluteTimeoutMs: 10000 },
  );
  const sessionId: string = session.sessionId;
  const events: AgentEvent[] = [];
  const exits: Array<{ code: number | null; wasCancelled: boolean; hadPendingPrompt: boolean }> = [];
  pool.attachSession(entry, sessionId, {
    sink: (ev) => events.push(ev),
    onProcessExit: (info) => exits.push(info),
  });
  return { sessionId, events, exits };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AcpPool', () => {
  const pools: AcpPool[] = [];
  function makePool(hooks?: ConstructorParameters<typeof AcpPool>[0]) {
    const pool = new AcpPool(hooks);
    pools.push(pool);
    return pool;
  }

  afterEach(async () => {
    // Drain every pool so no fake node process outlives the test file
    // (a leaked child keeps the node --test event loop alive).
    for (const pool of pools.splice(0)) {
      pool.drainAll('test-cleanup');
    }
    await sleep(150);
  });

  describe('acquire / reuse', () => {
    it('reuses the warm process for the same fingerprint (no respawn, no re-initialize)', async () => {
      const pool = makePool();
      const entry1 = await pool.acquire(makeSpec());
      const pid1 = entry1.child.pid;
      const entry2 = await pool.acquire(makeSpec());
      assert.equal(entry2.id, entry1.id, 'second acquire must return the same entry');
      assert.equal(entry2.child.pid, pid1, 'same underlying process');
      assert.equal(pool.__size(), 1);
    });

    it('deduplicates concurrent acquires onto one spawn (no stampede)', async () => {
      const pool = makePool();
      const [e1, e2] = await Promise.all([pool.acquire(makeSpec()), pool.acquire(makeSpec())]);
      assert.equal(e1.id, e2.id);
      assert.equal(pool.__size(), 1);
    });

    it('drains and respawns when the fingerprint changes (provider config edited)', async () => {
      const pool = makePool();
      const entry1 = await pool.acquire(makeSpec({ fingerprint: 'fp-A' }));
      const pid1 = entry1.child.pid;
      const exits: unknown[] = [];
      pool.attachSession(entry1, 'legacy-session', {
        sink: () => {},
        onProcessExit: (info) => exits.push(info),
      });

      const entry2 = await pool.acquire(makeSpec({ fingerprint: 'fp-B' }));
      assert.notEqual(entry2.id, entry1.id, 'fingerprint change must respawn');
      assert.notEqual(entry2.child.pid, pid1);
      assert.equal(entry1.alive, false, 'old entry must be finalized');
      assert.equal(exits.length, 1, 'attached runs on the old entry must be notified');
      assert.equal(pool.__size(), 1);
    });

    it('initialize failure rejects acquire, removes the entry, and decorates the error with last stderr', async () => {
      const pool = makePool();
      // INIT_ERROR: JSON-RPC error response to initialize.
      await assert.rejects(
        pool.acquire(makeSpec({ envFlags: { FAKE_HERMES_INIT_ERROR: '1' } })),
        /ACP error -32603: fake init error/,
      );
      assert.equal(pool.__getEntry('hermes'), undefined, 'failed entry must not stay in the pool');
      assert.equal(pool.__size(), 0);
    });

    it('initialize idle timeout kills the hung process and rejects acquire', async () => {
      const pool = makePool();
      await assert.rejects(
        pool.acquire(makeSpec({
          envFlags: { FAKE_HERMES_NO_INIT: '1' },
          idleTimeoutMs: 200,
          absoluteTimeoutMs: 5000,
        })),
        /ACP idle timeout: initialize/,
      );
      assert.equal(pool.__getEntry('hermes'), undefined);
    });
  });

  describe('multi-session on one process', () => {
    it('two sessions get unique ids and demuxed events from the same process', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec());

      const s1 = await createAndAttach(pool, entry);
      const s2 = await createAndAttach(pool, entry);
      assert.notEqual(s1.sessionId, s2.sessionId, 'fake server must issue unique session ids');

      // Prompt both sessions — each streams 'Hello from fake hermes' into its
      // OWN sink (the fake echoes params.sessionId in its updates).
      const p1 = entry.transport.request(
        'session/prompt',
        { sessionId: s1.sessionId, prompt: [] },
        { idleTimeoutMs: 3000, absoluteTimeoutMs: 10000, sessionId: s1.sessionId },
      );
      const p2 = entry.transport.request(
        'session/prompt',
        { sessionId: s2.sessionId, prompt: [] },
        { idleTimeoutMs: 3000, absoluteTimeoutMs: 10000, sessionId: s2.sessionId },
      );
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal((r1 as any).stopReason, 'end_turn');
      assert.equal((r2 as any).stopReason, 'end_turn');

      for (const s of [s1, s2]) {
        assert.ok(
          s.events.some(e => e.type === 'text_delta' && (e as any).delta === 'Hello from fake hermes'),
          `session ${s.sessionId} should receive its own text_delta`,
        );
        assert.ok(s.events.some(e => e.type === 'tool_use'), 'tool_call routed to owning session');
      }
      assert.equal(entry.sessions.size, 2, 'both sessions attached to the single entry');
    });

    it('detachSession unregisters the sink and is idempotent', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({ fingerprint: 'fp-detach' }));
      const s1 = await createAndAttach(pool, entry);

      pool.detachSession(entry.id, s1.sessionId);
      pool.detachSession(entry.id, s1.sessionId); // idempotent — must not throw
      assert.equal(entry.sessions.size, 0);
      assert.deepEqual(entry.transport.sessionIds(), []);

      // Events for the detached session are dropped, not thrown.
      entry.transport.feed(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: s1.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after detach' } } },
      }) + '\n');
      assert.equal(s1.events.filter(e => e.type === 'text_delta' && (e as any).delta === 'after detach').length, 0);
    });
  });

  describe('early events replay', () => {
    it('buffers pre-attach stderr diagnostics and replays them to the first session', async () => {
      const pool = makePool();
      // Heartbeat: fake prints stderr INFO lines during a slow initialize —
      // classified + buffered BEFORE any session exists.
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_SLOW_INIT_MS: '400', FAKE_HERMES_INIT_HEARTBEAT: '1' },
      }));
      assert.ok(entry.earlyEvents.length > 0, 'stderr during initialize must be buffered');

      const s1 = await createAndAttach(pool, entry);
      assert.ok(s1.events.length > 0, 'first attaching session must receive the buffered cold-start diagnostics');
      assert.equal(entry.earlyEvents.length, 0, 'buffer is drained by replay');
    });
  });

  describe('crash handling', () => {
    it('process exit mid-prompt fails the attached run and removes the entry', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_EXIT_DURING_PROMPT: '1' },
        fingerprint: 'fp-crash',
      }));
      const s1 = await createAndAttach(pool, entry);

      const prompt = entry.transport.request(
        'session/prompt',
        { sessionId: s1.sessionId, prompt: [] },
        { idleTimeoutMs: 5000, absoluteTimeoutMs: 10000, sessionId: s1.sessionId },
      );
      await assert.rejects(prompt, /process exited/);

      assert.equal(s1.exits.length, 1, 'onProcessExit must fire for the attached run');
      assert.equal(s1.exits[0]!.hadPendingPrompt, true, 'mid-prompt crash must be flagged');
      assert.equal(s1.exits[0]!.wasCancelled, false);
      assert.equal(entry.alive, false);
      assert.equal(pool.__getEntry('hermes'), undefined, 'dead entry must be removed so next acquire respawns');
    });

    it('crash broadcasts to ALL attached sessions (each run learns its process died)', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_EXIT_AFTER_INIT: '1' },
        fingerprint: 'fp-broadcast',
      }));
      // EXIT_AFTER_INIT: fake exits ~50ms after initialize. Attach two
      // synthetic sessions immediately (no session/new round-trip — that
      // would race the exit); both must learn the process died.
      assert.equal(entry.alive, true);
      const exitsA: unknown[] = [];
      const exitsB: unknown[] = [];
      pool.attachSession(entry, 'sess-a', { sink: () => {}, onProcessExit: (i) => exitsA.push(i) });
      pool.attachSession(entry, 'sess-b', { sink: () => {}, onProcessExit: (i) => exitsB.push(i) });

      await sleep(400);
      assert.equal(entry.alive, false);
      assert.equal(exitsA.length, 1, 'first attached session must be notified');
      assert.equal(exitsB.length, 1, 'second attached session must be notified');
      assert.equal((exitsA[0] as any).hadPendingPrompt, false, 'no prompt was in flight');
      assert.equal(pool.__getEntry('hermes'), undefined);
    });
  });

  describe('timeout blast radius', () => {
    it('session-scoped prompt timeout rejects only that request — process survives', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_PROMPT_HANG_WITH_STDERR: '1' },
        fingerprint: 'fp-hang',
      }));
      const s1 = await createAndAttach(pool, entry);

      // Fake prints 3 INFO lines (each resets the idle timer), then goes
      // silent — with a 300ms idle timeout the request rejects ~450ms in
      // while the process keeps running for other sessions.
      const prompt = entry.transport.request(
        'session/prompt',
        { sessionId: s1.sessionId, prompt: [] },
        { idleTimeoutMs: 300, absoluteTimeoutMs: 10000, sessionId: s1.sessionId },
      );
      await assert.rejects(prompt, /ACP idle timeout/);

      assert.equal(entry.alive, true, 'shared process must survive a single hung session');
      assert.equal(pool.__getEntry('hermes'), entry);
      assert.equal(s1.exits.length, 0);
    });

    it('transport-level session/new timeout kills the useless process', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_SLOW_SESSION_NEW_MS: '5000' },
        fingerprint: 'fp-slow-new',
      }));
      // Attach a synthetic session directly — createAndAttach's own session/new
      // would also hit the 5s fake delay and time out first.
      const exits: unknown[] = [];
      pool.attachSession(entry, 'sess-victim', { sink: () => {}, onProcessExit: (i) => exits.push(i) });

      // session/new is transport-scoped (no options.sessionId): a process that
      // can't complete the handshake is useless to every session → killChild.
      const newSession = entry.transport.request(
        'session/new',
        { mcpServers: [], cwd: os.tmpdir() },
        { idleTimeoutMs: 200, absoluteTimeoutMs: 10000 },
      );
      await assert.rejects(newSession, /ACP idle timeout: session\/new/);

      await sleep(100);
      assert.equal(entry.alive, false, 'transport-level timeout must finalize the entry');
      assert.equal(pool.__getEntry('hermes'), undefined);
      assert.equal(exits.length, 1, 'already-attached runs must be notified');
    });
  });

  describe('drain', () => {
    it('drain kills the process, notifies attached runs, and empties the pool', async () => {
      const pool = makePool();
      const entry = await pool.acquire(makeSpec({ fingerprint: 'fp-drain' }));
      const s1 = await createAndAttach(pool, entry);

      pool.drain('hermes', 'provider config changed');
      assert.equal(entry.alive, false);
      assert.equal(pool.__getEntry('hermes'), undefined);
      assert.equal(s1.exits.length, 1);
      assert.equal(s1.exits[0]!.hadPendingPrompt, false, 'no prompt was in flight');

      // Re-acquire after drain spawns fresh.
      const entry2 = await pool.acquire(makeSpec({ fingerprint: 'fp-drain' }));
      assert.notEqual(entry2.id, entry.id);
      assert.equal(entry2.alive, true);
    });

    it('drainAll empties every agent entry', async () => {
      const pool = makePool();
      await pool.acquire(makeSpec({ agentId: 'hermes', fingerprint: 'fp-a' }));
      await pool.acquire(makeSpec({ agentId: 'dsh', fingerprint: 'fp-b' }));
      assert.equal(pool.__size(), 2);
      pool.drainAll();
      assert.equal(pool.__size(), 0);
    });

    it('drain on an unknown agent is a no-op', () => {
      const pool = makePool();
      pool.drain('nonexistent');
      assert.equal(pool.__size(), 0);
    });
  });

  describe('idle TTL eviction', () => {
    it('evicts the process after the last session detaches and the TTL elapses', async () => {
      const prev = process.env['MOLIO_ACP_POOL_IDLE_MS'];
      process.env['MOLIO_ACP_POOL_IDLE_MS'] = '250';
      try {
        const pool = makePool();
        const entry = await pool.acquire(makeSpec({ fingerprint: 'fp-idle' }));
        const s1 = await createAndAttach(pool, entry);
        assert.equal(entry.alive, true);

        pool.detachSession(entry.id, s1.sessionId);
        await sleep(600);
        assert.equal(entry.alive, false, 'idle entry must be evicted after TTL');
        assert.equal(pool.__getEntry('hermes'), undefined);
      } finally {
        if (prev === undefined) delete process.env['MOLIO_ACP_POOL_IDLE_MS'];
        else process.env['MOLIO_ACP_POOL_IDLE_MS'] = prev;
      }
    });

    it('reattaching a session before the TTL fires cancels eviction', async () => {
      const prev = process.env['MOLIO_ACP_POOL_IDLE_MS'];
      process.env['MOLIO_ACP_POOL_IDLE_MS'] = '400';
      try {
        const pool = makePool();
        const entry = await pool.acquire(makeSpec({ fingerprint: 'fp-idle-rearm' }));
        const s1 = await createAndAttach(pool, entry);
        pool.detachSession(entry.id, s1.sessionId);
        await sleep(150);
        // Re-attach (new session on the same warm process) — timer disarmed.
        const s2 = await createAndAttach(pool, entry);
        await sleep(500);
        assert.equal(entry.alive, true, 're-attach must cancel the pending eviction');
        assert.equal(entry.sessions.size, 1);
        assert.equal(s2.exits.length, 0);
      } finally {
        if (prev === undefined) delete process.env['MOLIO_ACP_POOL_IDLE_MS'];
        else process.env['MOLIO_ACP_POOL_IDLE_MS'] = prev;
      }
    });
  });

  describe('misc queries', () => {
    it('hasLiveEntry / isEntryAlive / getLastStderrLine', async () => {
      const pool = makePool();
      assert.equal(pool.hasLiveEntry('hermes'), false);
      const entry = await pool.acquire(makeSpec({
        envFlags: { FAKE_HERMES_SLOW_INIT_MS: '300', FAKE_HERMES_INIT_HEARTBEAT: '1' },
        fingerprint: 'fp-misc',
      }));
      assert.equal(pool.hasLiveEntry('hermes'), true);
      assert.equal(pool.isEntryAlive(entry.id), true);
      assert.equal(pool.isEntryAlive('bogus-id'), false);
      // Heartbeat stderr lines were tracked at entry level.
      assert.ok(typeof pool.getLastStderrLine(entry.id) === 'string');
      pool.drain('hermes');
      assert.equal(pool.hasLiveEntry('hermes'), false);
      assert.equal(pool.isEntryAlive(entry.id), false, 'dead entries are removed — id no longer resolves');
    });
  });
});

describe('classifyAcpStderrLine', () => {
  it('dsh: explicit error headers become error events, everything else stays raw', () => {
    assert.deepEqual(classifyAcpStderrLine('dsh', 'dsh: error: provider key missing'), {
      type: 'error', message: 'dsh: error: provider key missing',
    });
    assert.deepEqual(classifyAcpStderrLine('dsh', 'Error: something blew up'), {
      type: 'error', message: 'Error: something blew up',
    });
    assert.deepEqual(classifyAcpStderrLine('dsh', 'dsh: warning: 1 entry did not activate'), {
      type: 'raw', line: 'dsh: warning: 1 entry did not activate',
    });
    assert.deepEqual(classifyAcpStderrLine('dsh', '(node:123) ExperimentalWarning: blah'), {
      type: 'raw', line: '(node:123) ExperimentalWarning: blah',
    });
  });

  it('hermes: timestamped INFO/WARNING/DEBUG stay raw, ERROR and tracebacks surface', () => {
    assert.deepEqual(classifyAcpStderrLine('hermes', '2026-10-09 12:00:00 [INFO] hermes.plugins: loaded'), {
      type: 'raw', line: '2026-10-09 12:00:00 [INFO] hermes.plugins: loaded',
    });
    assert.deepEqual(classifyAcpStderrLine('hermes', '2026-10-09 12:00:00 [WARNING] x: y'), {
      type: 'raw', line: '2026-10-09 12:00:00 [WARNING] x: y',
    });
    assert.deepEqual(classifyAcpStderrLine('hermes', '2026-10-09 12:00:00 [ERROR] x: boom'), {
      type: 'error', message: '2026-10-09 12:00:00 [ERROR] x: boom',
    });
    assert.deepEqual(classifyAcpStderrLine('hermes', 'Traceback (most recent call last):'), {
      type: 'error', message: 'Traceback (most recent call last):',
    });
  });
});
