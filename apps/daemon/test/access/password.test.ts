import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { hashPassword, verifyPassword, isValidPasswordHash } from '../../src/core/access/password.js';

test('password hashes use random salts and verify the supplied password', async () => {
  const first = await hashPassword('correct horse battery staple');
  const second = await hashPassword('correct horse battery staple');
  assert.notEqual(first, second);
  assert.equal(isValidPasswordHash(first), true);
  assert.equal(await verifyPassword('correct horse battery staple', first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
});

test('malformed hashes and arbitrary scrypt parameters are rejected', async () => {
  for (const hash of ['', 'not-a-hash', `scrypt$65536$8$1$${'ab'.repeat(16)}$${'cd'.repeat(64)}`]) {
    assert.equal(isValidPasswordHash(hash), false);
    assert.equal(await verifyPassword('password', hash), false);
  }
});
