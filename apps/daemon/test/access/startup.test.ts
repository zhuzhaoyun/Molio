import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(5000).then(() => { child.kill('SIGKILL'); })]);
}

test('invalid server configuration fails before initialization or listening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-startup-'));
  const data = join(dir, 'data'); const port = await freePort();
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MOLIO_ACCESS_MODE: 'server', MOLIO_DATA_DIR: data, MOLIO_PORT: String(port), MOLIO_ADMIN_USERNAME: '', MOLIO_ADMIN_PASSWORD_HASH: '', MOLIO_PUBLIC_URL: '' }, stdio: 'pipe' });
    const result = await Promise.race([new Promise<number | null>((resolve) => child.once('exit', resolve)), delay(15000).then(() => null)]);
    await stop(child);
    assert.notEqual(result, 0);
    assert.notEqual(result, null, 'process must exit instead of timing out');
    assert.equal(existsSync(data), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local starts on numeric loopback and preserves the health response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-startup-')); const port = await freePort();
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), env: { ...process.env, MOLIO_ACCESS_MODE: 'local', MOLIO_HOST: '127.0.0.1', MOLIO_DATA_DIR: dir, MOLIO_PORT: String(port), MOLIO_CHORES_DELAY_MS: '300000', MOLIO_CLAUDE_HOME: join(dir, 'claude'), MOLIO_CODEX_HOME: join(dir, 'codex') }, stdio: 'pipe' });
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await delay(100); }
    }
    assert.ok(response, 'daemon did not listen');
    const health = await response.json() as { status: string; memory: unknown };
    assert.equal(health.status, 'ok'); assert.ok(health.memory);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
