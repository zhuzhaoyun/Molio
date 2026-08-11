/**
 * crypto-server.js 行为级测试：mock safeStorage + 真 node:http server。
 * 纯 Node 跑（不 import electron）——safeStorage 经构造参数注入。
 *
 * 覆盖 daemon 侧 desktop-crypto.ts 会遇到的全部响应形态：
 * 成功往返 / 加密不可用 503 / 坏 body 400 / 超限 413 / health。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCryptoRequestHandler,
  startCryptoServer,
  stopCryptoServer,
} from '../../src/crypto-server.js';

/**
 * mock safeStorage：encrypt = 'mock:' + base64（确定性、可区分、可还原），
 * decrypt 只认 'mock:' 前缀（跨机器数据必败），行为可运行时切换。
 */
function makeMockSafeStorage({ available = true, failEncrypt = false } = {}) {
  const state = { available, failEncrypt, encryptCalls: 0, decryptCalls: 0 };
  return {
    state,
    crypto: {
      isEncryptionAvailable: () => state.available,
      encryptString: (plaintext) => {
        state.encryptCalls += 1;
        if (state.failEncrypt) throw new Error('DPAPI unavailable');
        return Buffer.from(`mock:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8');
      },
      decryptString: (buf) => {
        state.decryptCalls += 1;
        const text = Buffer.from(buf).toString('utf8');
        if (!text.startsWith('mock:')) throw new Error('not encrypted by this machine');
        return Buffer.from(text.slice('mock:'.length), 'base64').toString('utf8');
      },
    },
  };
}

describe('crypto-server', () => {
  let mock;
  let port;

  beforeEach(async () => {
    mock = makeMockSafeStorage();
    port = await startCryptoServer(mock.crypto);
  });

  afterEach(async () => {
    await stopCryptoServer();
  });

  const base = () => `http://127.0.0.1:${port}`;

  it('encrypt → decrypt round-trip restores plaintext', async () => {
    const plaintext = JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: { id: 'u1' } });
    const encRes = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext }),
    });
    assert.equal(encRes.status, 200);
    const { data } = await encRes.json();
    assert.equal(typeof data, 'string');
    assert.ok(!data.includes('refreshToken'), 'ciphertext must not leak plaintext fields');

    const decRes = await fetch(`${base()}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    assert.equal(decRes.status, 200);
    assert.deepEqual(await decRes.json(), { plaintext });
  });

  it('GET /health reports availability', async () => {
    const res = await fetch(`${base()}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, available: true });
  });

  it('encryption unavailable → 503 for both endpoints (daemon falls back)', async () => {
    mock.state.available = false;
    const encRes = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: 'hi' }),
    });
    assert.equal(encRes.status, 503);
    assert.equal((await encRes.json()).error, 'crypto_unavailable');

    const decRes = await fetch(`${base()}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'bW9jazp4' }),
    });
    assert.equal(decRes.status, 503);
  });

  it('encryptString throwing at runtime → 503 encrypt_failed', async () => {
    mock.state.failEncrypt = true;
    const res = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: 'hi' }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'encrypt_failed');
  });

  it('foreign-machine blob (decrypt throws) → 400 decrypt_failed', async () => {
    const foreign = Buffer.from('not-our-blob', 'utf8').toString('base64');
    const res = await fetch(`${base()}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: foreign }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'decrypt_failed');
  });

  it('invalid JSON body → 400', async () => {
    const res = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_json');
  });

  it('missing / wrong-type fields → 400', async () => {
    for (const body of [{}, { plaintext: 42 }, { plaintext: '' }]) {
      const res = await fetch(`${base()}/encrypt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `body=${JSON.stringify(body)}`);
      assert.equal((await res.json()).error, 'invalid_plaintext');
    }
    for (const body of [{}, { data: 42 }, { data: '' }]) {
      const res = await fetch(`${base()}/decrypt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `body=${JSON.stringify(body)}`);
      assert.equal((await res.json()).error, 'invalid_data');
    }
  });

  it('oversized body → 413', async () => {
    const res = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  it('unknown route → 404', async () => {
    const res = await fetch(`${base()}/nope`);
    assert.equal(res.status, 404);
  });

  it('handler factory is usable without startCryptoServer (unit shape)', () => {
    const handler = createCryptoRequestHandler(mock.crypto);
    assert.equal(typeof handler, 'function');
  });
});
