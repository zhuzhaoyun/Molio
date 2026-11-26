import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopDaemonEnvironment } from '../src/daemon-env.js';

test('packaged desktop daemon always uses local IPv4 without mutating inherited environment', () => {
  const inherited = { MOLIO_ACCESS_MODE: 'server', MOLIO_HOST: '0.0.0.0', MOLIO_AUTH_URL: 'https://example.test' };
  const actual = desktopDaemonEnvironment(inherited);
  assert.equal(actual.MOLIO_ACCESS_MODE, 'local');
  assert.equal(actual.MOLIO_HOST, '127.0.0.1');
  assert.equal(actual.MOLIO_AUTH_URL, inherited.MOLIO_AUTH_URL);
  assert.equal(inherited.MOLIO_ACCESS_MODE, 'server');
});
