import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from '../../src/core/access/password.js';

const origin = 'https://example.test';
async function freePort(): Promise<number> {
  const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return p;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('server authentication, CSRF, stream revocation and restart persistence', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-server-smoke-')); const port = await freePort();
  const vault = join(dir, 'vault'); mkdirSync(vault);
  const hash = await hashPassword('long test password'); const changedHash = await hashPassword('different long password');
  let child: ChildProcess | undefined;
  const base = `http://127.0.0.1:${port}`;
  async function start(passwordHash: string) {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MOLIO_ACCESS_MODE: 'server', MOLIO_HOST: '127.0.0.1', MOLIO_DATA_DIR: join(dir, 'data'), MOLIO_PORT: String(port), MOLIO_PUBLIC_URL: origin, MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: passwordHash, MOLIO_CHORES_DELAY_MS: '300000', MOLIO_CLAUDE_HOME: join(dir, 'claude'), MOLIO_CODEX_HOME: join(dir, 'codex') }, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
      if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}`);
      await delay(100);
    }
    throw new Error('daemon failed to start');
  }
  async function signIn() {
    const res = await fetch(`${base}/api/access/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'long test password' }) });
    assert.equal(res.status, 200); const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const state = await (await fetch(`${base}/api/access/session`, { headers: { cookie } })).json() as { authenticated: boolean; csrfToken: string; expiresAt: number };
    assert.equal(state.authenticated, true);
    return { cookie, csrf: state.csrfToken, expiresAt: state.expiresAt };
  }
  try {
    await start(hash);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok' });
    for (const [method, path] of [['GET', '/api/config'], ['GET', '/api/knowledge/vaults'], ['POST', '/api/runs'], ['GET', '/api/graph/x'], ['POST', '/api/shutdown']] as const) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 401, path);
    }
    const one = await signIn(); const two = await signIn();
    assert.notEqual(one.cookie, two.cookie);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: one.cookie } })).status, 200);
    const write = (headers: Record<string, string>) => fetch(`${base}/api/config`, { method: 'PUT', headers: { cookie: one.cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal((await write({ origin })).status, 403);
    assert.equal((await write({ origin, 'x-molio-csrf': '0'.repeat(64) })).status, 403);
    assert.equal((await write({ 'x-molio-csrf': one.csrf })).status, 403);
    assert.equal((await write({ origin, 'x-molio-csrf': one.csrf })).status, 200);
    const created = await fetch(`${base}/api/knowledge/vaults`, { method: 'POST', headers: { cookie: one.cookie, origin, 'x-molio-csrf': one.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'test', path: vault }) });
    assert.equal(created.status, 201);
    const { id } = await created.json() as { id: string };
    const aPromise = fetch(`${base}/api/knowledge/vaults/${id}/events`, { headers: { cookie: one.cookie } });
    const bPromise = fetch(`${base}/api/knowledge/vaults/${id}/events`, { headers: { cookie: two.cookie } });
    // Trigger file events until both streams have delivered headers and their first frame.
    const ticker = setInterval(() => { try { writeFileSync(join(vault, 'changed.md'), String(Date.now())); } catch { /* teardown */ } }, 400);
    let a: Response, b: Response;
    try { [a, b] = await Promise.all([aPromise, bPromise]); } finally { clearInterval(ticker); }
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const ar = a.body!.getReader(); const br = b.body!.getReader();
    assert.equal((await ar.read()).done, false); assert.equal((await br.read()).done, false);
    const waitForEnd = ar.read();
    assert.equal((await fetch(`${base}/api/access/logout`, { method: 'POST', headers: { cookie: one.cookie, origin, 'x-molio-csrf': one.csrf } })).status, 204);
    assert.equal((await waitForEnd).done, true);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: one.cookie } })).status, 401);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: two.cookie } })).status, 200);
    await br.cancel();
    await stop(child!); await start(hash);
    const restored = await (await fetch(`${base}/api/access/session`, { headers: { cookie: two.cookie } })).json() as { authenticated: boolean; expiresAt: number };
    assert.equal(restored.authenticated, true); assert.equal(restored.expiresAt, two.expiresAt);
    await stop(child!); await start(changedHash);
    assert.equal((await fetch(`${base}/api/config`, { headers: { cookie: two.cookie } })).status, 401);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
