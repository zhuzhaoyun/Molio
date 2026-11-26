import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadAccessConfig } from '../../src/core/access/config.js';

test('local mode defaults to a loopback listener', () => {
  const config = loadAccessConfig({});
  assert.equal(config.mode, 'local');
  assert.equal(config.host, '127.0.0.1');
});

test('local mode rejects non-loopback listeners', () => {
  assert.throws(() => loadAccessConfig({ MOLIO_HOST: '0.0.0.0' }));
});

test('server mode fails closed without administrator and HTTPS configuration', () => {
  assert.throws(() => loadAccessConfig({ MOLIO_ACCESS_MODE: 'server' }));
  assert.throws(() => loadAccessConfig({ MOLIO_ACCESS_MODE: 'server', MOLIO_PUBLIC_URL: 'http://example.com', MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: 'x' }));
});

test('unknown access modes fail closed', () => {
  assert.throws(() => loadAccessConfig({ MOLIO_ACCESS_MODE: 'public' }));
});

test('localhost is normalized to numeric loopback', () => {
  assert.equal(loadAccessConfig({ MOLIO_HOST: 'localhost' }).host, '127.0.0.1');
});

test('server requires a valid password hash and https origin', () => {
  const env = { MOLIO_ACCESS_MODE: 'server', MOLIO_PUBLIC_URL: 'https://example.com', MOLIO_ADMIN_USERNAME: 'admin', MOLIO_ADMIN_PASSWORD_HASH: 'not-a-hash' };
  assert.throws(() => loadAccessConfig(env));
  const hash = `scrypt$32768$8$1$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
  assert.equal(loadAccessConfig({ ...env, MOLIO_ADMIN_PASSWORD_HASH: hash }).mode, 'server');
  assert.throws(() => loadAccessConfig({ ...env, MOLIO_ADMIN_PASSWORD_HASH: hash, MOLIO_PUBLIC_URL: 'https://example.com/path' }));
  for (const url of ['https://example.com/?', 'https://example.com/#', 'https://example.com/a/..', 'https://@example.com']) {
    assert.throws(() => loadAccessConfig({ ...env, MOLIO_ADMIN_PASSWORD_HASH: hash, MOLIO_PUBLIC_URL: url }), url);
  }
});
