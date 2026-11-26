/**
 * @area auth
 * @priority P1
 * Browser coverage for the phase-one server session behind a TLS proxy.
 */
import { test, expect } from '@playwright/test';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test.use({ ignoreHTTPSErrors: true });

test('HTTPS browser stores an HttpOnly administrator cookie and enforces CSRF', async ({ page, context }) => {
  test.skip(spawnSync('openssl', ['version']).status !== 0, 'openssl is required for the local TLS test');
  test.setTimeout(90000);
  const dir = mkdtempSync(join(tmpdir(), 'molio-browser-auth-'));
  let daemon: ChildProcess | undefined;
  let proxy: ReturnType<typeof createHttpsServer> | undefined;
  try {
    const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const socket = createServer();
    await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
    const daemonPort = (socket.address() as { port: number }).port;
    await new Promise<void>((r) => socket.close(() => r()));
    proxy = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      const upstream = httpRequest({ hostname: '127.0.0.1', port: daemonPort, method: req.method, path: req.url, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise<void>((r) => proxy!.listen(0, '127.0.0.1', r));
    const proxyPort = (proxy.address() as { port: number }).port;
    const origin = `https://localhost:${proxyPort}`;
    const salt = randomBytes(16); const pass = 'browser test password';
    const keyHash = scryptSync(pass, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const encoded = `scrypt$32768$8$1$${salt.toString('hex')}$${keyHash.toString('hex')}`;
    daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(process.cwd(), '../daemon'), stdio: 'ignore',
      env: { ...process.env, MOLIO_ACCESS_MODE: 'server', MOLIO_HOST: '127.0.0.1', MOLIO_DATA_DIR: join(dir, 'data'), MOLIO_PORT: String(daemonPort), MOLIO_PUBLIC_URL: origin, MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: encoded, MOLIO_CHORES_DELAY_MS: '300000', MOLIO_CLAUDE_HOME: join(dir, 'claude'), MOLIO_CODEX_HOME: join(dir, 'codex') },
    });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`http://127.0.0.1:${daemonPort}/api/health`)).ok) { ready = true; break; } } catch { /* starting */ }
      if (daemon.exitCode !== null) throw new Error(`daemon exited ${daemon.exitCode}`);
      await delay(100);
    }
    expect(ready).toBe(true);
    await page.goto(`${origin}/api/health`);
    const unauthorized = await page.evaluate(async () => (await fetch('/api/config')).status);
    expect(unauthorized).toBe(401);
    const login = await page.evaluate(async ({ password }) => {
      const response = await fetch('/api/access/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
      return { status: response.status, cache: response.headers.get('cache-control') };
    }, { password: pass });
    expect(login).toEqual({ status: 200, cache: 'no-store' });
    const cookies = await context.cookies(origin);
    const cookie = cookies.find((item) => item.name === '__Host-molio_admin');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-molio_admin');
    const result = await page.evaluate(async () => {
      const session = await (await fetch('/api/access/session')).json();
      const read = await fetch('/api/config');
      const blocked = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      const write = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-molio-csrf': session.csrfToken }, body: '{}' });
      const logout = await fetch('/api/access/logout', { method: 'POST', headers: { 'x-molio-csrf': session.csrfToken } });
      const after = await fetch('/api/config');
      return { authenticated: session.authenticated, read: read.status, blocked: blocked.status, write: write.status, logout: logout.status, after: after.status };
    });
    expect(result).toEqual({ authenticated: true, read: 200, blocked: 403, write: 200, logout: 204, after: 401 });
    expect((await context.cookies(origin)).some((item) => item.name === '__Host-molio_admin')).toBe(false);
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await new Promise<void>((r) => {
        const timer = setTimeout(() => { daemon?.kill('SIGKILL'); r(); }, 5000);
        timer.unref();
        daemon!.once('exit', () => { clearTimeout(timer); r(); });
      });
    }
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy!.close(() => r()));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
