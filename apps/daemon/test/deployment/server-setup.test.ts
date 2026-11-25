import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { hashPassword, verifyPassword } from '../../src/core/access/password.js';
import { loadAccessConfig } from '../../src/core/access/config.js';

const root = resolve(process.cwd(), '../..');
const script = join(root, 'scripts/setup-server.mjs');
test('server setup writes a daemon-compatible hash without exposing it and preserves unrelated settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-server-setup-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, '# Keep AI configuration\nANTHROPIC_API_KEY=fixture-value\nMOLIO_VAULT_PATH=/data/notes\n');
    const hash = await hashPassword('a-long-test-password');
    const result = spawnSync(process.execPath, [script, '--config', file, '--non-interactive'], {
      env: { ...process.env, MOLIO_PUBLIC_URL: 'https://wiki.example.test/', MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: hash }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(hash));
    const setup = await import(new URL(`file://${script}`).href);
    const parsed = setup.parseEnv(readFileSync(file, 'utf8'));
    const config = loadAccessConfig(parsed);
    assert.equal(config.mode, 'server');
    assert.equal(parsed.MOLIO_PUBLIC_URL, 'https://wiki.example.test');
    assert.equal(parsed.MOLIO_SITE_ADDRESS, 'wiki.example.test');
    assert.equal(parsed.ANTHROPIC_API_KEY, 'fixture-value');
    assert.equal(parsed.MOLIO_VAULT_PATH, '/data/notes');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(await verifyPassword('a-long-test-password', parsed.MOLIO_ADMIN_PASSWORD_HASH), true);
    // Re-running must retain the exact credential fingerprint and independent sessions.
    const rerun = spawnSync(process.execPath, [script, '--config', file, '--non-interactive'], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOLIO_ADMIN_') && key !== 'MOLIO_PUBLIC_URL')), encoding: 'utf8',
    });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(setup.parseEnv(readFileSync(file, 'utf8')).MOLIO_ADMIN_PASSWORD_HASH, hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid or missing non-interactive server credentials fail without changing the existing env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-server-invalid-'));
  try {
    const file = join(dir, '.env');
    const original = 'MOLIO_VAULT_PATH=/keep/me\n'; writeFileSync(file, original);
    for (const url of ['http://public.example.test', 'https://u:p@public.example.test', 'https://wiki.example.test/path', 'https://wiki.example.test', '']) {
      const result = spawnSync(process.execPath, [script, '--config', file, '--non-interactive'], {
        env: { ...process.env, MOLIO_PUBLIC_URL: url, MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: 'invalid' }, encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installer releases byte-identical deployment templates and passes bash syntax checks', () => {
  const installer = readFileSync(join(root, 'install.sh'), 'utf8');
  for (const [file, tag] of [['docker-compose.yml', 'COMPOSE_EOF'], ['.env.example', 'ENV_EXAMPLE_EOF'], ['docker-compose.https.yml', 'HTTPS_COMPOSE_EOF'], ['Caddyfile', 'CADDY_EOF'], ['scripts/setup-server.mjs', 'SERVER_SETUP_EOF']] as const) {
    const body = installer.match(new RegExp(`<< '${tag}'\\n([\\s\\S]*?)\\n${tag}`))?.[1];
    assert.equal(body + '\n', readFileSync(join(root, file), 'utf8'), file);
  }
  if (process.platform !== 'win32') execFileSync('bash', ['-n', join(root, 'install.sh')]);
});

test('deployment config isolates the listener and gives the HTTPS proxy no administrator credentials', async () => {
  const { parse } = await import('yaml');
  const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8'));
  assert.deepEqual(compose.services.molio.ports, ['${MOLIO_BIND_ADDRESS:-127.0.0.1}:${MOLIO_PORT:-3100}:3100']);
  assert.ok(compose.services.molio.environment.includes('MOLIO_ACCESS_MODE=server'));
  assert.ok(compose.services.molio.environment.includes('MOLIO_HOST=0.0.0.0'));
  const https = parse(readFileSync(join(root, 'docker-compose.https.yml'), 'utf8'));
  assert.deepEqual(Object.keys(https.services.caddy.environment), ['MOLIO_SITE_ADDRESS']);
  assert.equal(https.services.caddy.depends_on.molio.condition, 'service_healthy');
  assert.deepEqual(https.services.caddy.ports, ['80:80', '443:443']);
});

test('env writing preserves literal dollars, quotes and unrelated settings and removes duplicate access keys', async () => {
  const setup = await import(new URL(`file://${script}`).href);
  const value = "admin'with$dollars\\backslash";
  const text = setup.renderEnv('KEEP=original\nMOLIO_ADMIN_USERNAME=old\nMOLIO_ADMIN_USERNAME=duplicate\n', { MOLIO_ADMIN_USERNAME: value });
  assert.equal(setup.parseEnv(text).MOLIO_ADMIN_USERNAME, value);
  assert.equal(setup.parseEnv(text).KEEP, 'original');
  assert.equal(text.match(/^MOLIO_ADMIN_USERNAME=/gm)?.length, 1);
});

test('installer verifies anonymous management denial before starting HTTPS and stops incompatible images', { skip: process.platform === 'win32' }, async () => {
  const hash = await hashPassword('a-long-installer-test-password');
  for (const scenario of ['incompatible', 'accepted', 'timeout']) {
    const accepted = scenario === 'accepted';
    const dir = mkdtempSync(join(tmpdir(), 'molio-install-flow-'));
    try {
      const bin = join(dir, 'bin');
      const { mkdirSync } = await import('node:fs'); mkdirSync(bin);
      const home = join(dir, 'app'); mkdirSync(home);
      const log = join(dir, 'events.jsonl');
      writeFileSync(join(home, '.env'), `MOLIO_PUBLIC_URL='https://wiki.example.test'\nMOLIO_ADMIN_USERNAME='admin'\nMOLIO_ADMIN_PASSWORD_HASH='${hash}'\n`);
      writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_EVENTS,JSON.stringify({tool:'docker',a})+'\\n');
if(a.includes('version')||a.includes('--version')) console.log('Docker Compose version test');
if(a.includes('run')){const r=cp.spawnSync(process.execPath,[process.env.MOLIO_HOME+'/.molio-setup-server.mjs','--config',process.env.MOLIO_HOME+'/.env','--non-interactive'],{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);}
`, { mode: 0o755 });
      writeFileSync(join(bin, 'curl'), `#!/usr/bin/env node
const fs=require('node:fs');const a=process.argv.slice(2);const url=a.at(-1);fs.appendFileSync(process.env.TEST_EVENTS,JSON.stringify({tool:'curl',url})+'\\n');
if(url.endsWith('/api/access/session')) console.log('{"mode":"server","authenticated":false}');
else if(url.endsWith('/api/config')) process.stdout.write(process.env.TEST_ACCEPTED==='1'?'401':'200');
else if(process.env.TEST_SCENARIO==='timeout') process.exit(22);
else console.log('{"status":"ok"}');
`, { mode: 0o755 });
      writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = spawnSync('bash', [join(root, 'install.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOLIO_HOME: home, NONINTERACTIVE: '1', MOLIO_ENABLE_HTTPS: '1', TEST_EVENTS: log, TEST_ACCEPTED: accepted ? '1' : '0', TEST_SCENARIO: scenario }, encoding: 'utf8' });
      const events = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const check = events.findIndex(e => e.tool === 'curl' && e.url.endsWith('/api/config'));
      const firstStart = events.findIndex(e => e.tool === 'docker' && e.a.includes('up'));
      assert.ok(firstStart >= 0);
      const closeProxy = events.findIndex(e => e.tool === 'docker' && e.a.includes('stop') && e.a.includes('caddy'));
      assert.ok(closeProxy >= 0 && closeProxy < firstStart, 'stop existing public proxy before replacing backend');
      if (scenario !== 'timeout') assert.ok(check > firstStart, result.stderr + result.stdout);
      assert.equal(events[firstStart].a.at(-1), 'molio', 'HTTPS must not start before access checks');
      const httpsStart = events.findIndex(e => e.tool === 'docker' && e.a.includes('up') && e.a.at(-1) !== 'molio');
      if (accepted) { assert.equal(result.status, 0, result.stderr); assert.ok(httpsStart > check); }
      else { assert.notEqual(result.status, 0); assert.equal(httpsStart, -1); assert.ok(events.some((e, i) => i > firstStart && e.tool === 'docker' && e.a.includes('stop') && e.a.includes('molio') && e.a.includes('caddy'))); }
      assert.ok(!`${result.stdout}${result.stderr}`.includes(hash));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});


test('Docker build context includes only the deployment initializer from scripts', () => {
  const patterns = readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  assert.ok(!patterns.includes('scripts') && !patterns.includes('scripts/'), 'parent must remain traversable');
  assert.ok(patterns.includes('scripts/*'));
  assert.ok(patterns.indexOf('!scripts/setup-server.mjs') > patterns.indexOf('scripts/*'));
  assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /COPY scripts\/setup-server\.mjs/);
});

test('Compose decodes generated special-character credentials exactly', { skip: !process.env.MOLIO_TEST_COMPOSE }, async () => {
  const setup = await import(new URL(`file://${script}`).href);
  const dir = mkdtempSync(join(tmpdir(), 'molio-compose-env-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), 'services:\n  fixture:\n    image: fixture\n    environment:\n      - VALUE=${VALUE}\n');
    for (const value of ["admin'with$dollars\\backslash", 'trailing\\', "slash\\'quote", '$literal']) {
      writeFileSync(join(dir, '.env'), setup.renderEnv('', { VALUE: value }));
      const output = execFileSync(process.env.MOLIO_TEST_COMPOSE!, ['--project-directory', dir, '-f', join(dir, 'compose.yml'), 'config', '--environment'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(output.split('\n').find(line => line.startsWith('VALUE=')), `VALUE=${value}`);
      assert.equal(setup.parseEnv(readFileSync(join(dir, '.env'), 'utf8')).VALUE, value);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
