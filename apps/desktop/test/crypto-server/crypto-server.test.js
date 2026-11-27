/**
 * crypto-server.js 行为级测试：mock safeStorage + 真 node:http server。
 * 纯 Node 跑（不 import electron）——safeStorage 经构造参数注入。
 *
 * 覆盖 daemon 侧 desktop-crypto.ts 会遇到的全部响应形态：
 * 成功往返 / 加密不可用 503 / 坏 body 400 / 超限 413 / health。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

/**
 * 直接用假 req/res EventEmitter 驱动 handler：精确控制 chunk 边界与 socket
 * 错误事件（真 HTTP 客户端无法稳定制造跨多字节字符的 chunk 切分）。
 */
function driveHandler(handler, { method, url, headers = {}, chunks = [], emitError = null }) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;
    const res = {
      statusCode: 0,
      body: '',
      writeHead(code) {
        this.statusCode = code;
      },
      end(data) {
        this.body = data ?? '';
        resolve(this);
      },
      on() {}, // res.on('error') 挂监听用
    };
    handler(req, res);
    for (const chunk of chunks) req.emit('data', chunk);
    if (emitError) req.emit('error', emitError);
    req.emit('end');
  });
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

  it('encryptString throwing at runtime → 503 encrypt_failed（通用错误体，不泄露 errMsg）', async () => {
    mock.state.failEncrypt = true;
    const res = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: 'hi' }),
    });
    assert.equal(res.status, 503);
    // message 可能含 OS/keychain 细节；daemon 把任何非 200 都当 null，错误体必须通用
    assert.deepEqual(await res.json(), { error: 'encrypt_failed' });
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

  it('尺寸闸门按字节而非字符数（多字节字符不得三倍超限溜过）', async () => {
    // '中' UTF-8 3 字节 / UTF-16 1 单元：30_000 字 = 90KB 字节 > 64KB 上限，
    // 但 string.length 只有 ~30k。旧的字符串拼接累积按 length 判断会漏放。
    const res = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: '中'.repeat(30_000) }),
    });
    assert.equal(res.status, 413);
  });

  it('跨 chunk 边界的多字节 UTF-8 字符仍 round-trip（Buffer 累积 vs 字符串拼接）', async () => {
    // 中文 UTF-8 每字 3 字节；chunk 在字符中间切开时，逐 chunk 字符串解码会
    // 产生 U+FFFD 乱码（明文损坏但 JSON 仍可解析）。Buffer 累积一次解码才保真。
    const plaintext = '中文明文加密 round-trip';
    const body = Buffer.from(JSON.stringify({ plaintext }), 'utf8');
    const splitAt = body.indexOf(Buffer.from('明', 'utf8')) + 1; // 切在 '明' 的第 2 字节处
    assert.ok(splitAt > 0 && splitAt < body.length);
    const handler = createCryptoRequestHandler(mock.crypto);
    const encRes = await driveHandler(handler, {
      method: 'POST',
      url: '/encrypt',
      chunks: [body.subarray(0, splitAt), body.subarray(splitAt)],
    });
    assert.equal(encRes.statusCode, 200);
    const { data } = JSON.parse(encRes.body);
    const decRes = await driveHandler(handler, {
      method: 'POST',
      url: '/decrypt',
      chunks: [Buffer.from(JSON.stringify({ data }), 'utf8')],
    });
    assert.equal(decRes.statusCode, 200);
    assert.deepEqual(JSON.parse(decRes.body), { plaintext });
  });

  it('body 中途 socket 出错：不崩溃，安全响应', async () => {
    const handler = createCryptoRequestHandler(mock.crypto);
    const res = await driveHandler(handler, {
      method: 'POST',
      url: '/encrypt',
      chunks: [Buffer.from('{"plaintext":"par')],
      emitError: new Error('socket hang up'),
    });
    // 'error' 后按超限丢弃：绝不因未处理的 socket 错误崩溃主进程
    assert.equal(res.statusCode, 413);
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

describe('crypto-server with shared secret（防本机他进程冒用随机端口）', () => {
  // 随机端口不是安全边界（本机进程可扫描）；main.js 每次启动生成新密钥经
  // MOLIO_DESKTOP_CRYPTO_TOKEN 注入 daemon，daemon 调用带 Bearer（desktop-crypto.ts），
  // 本服务逐次校验。此处起带 token 的真 server 验证闸门。
  const TOKEN = 'secret-abc';
  let mock;
  let port;

  beforeEach(async () => {
    mock = makeMockSafeStorage();
    port = await startCryptoServer(mock.crypto, { token: TOKEN });
  });

  afterEach(async () => {
    await stopCryptoServer();
  });

  const base = () => `http://127.0.0.1:${port}`;

  it('缺失/错误/畸形 Bearer → 401 unauthorized，加解密函数不被调用', async () => {
    const cases = [
      {},                                              // 无 Authorization
      { authorization: 'Bearer wrong-token' },         // 密钥错
      { authorization: 'Token secret-abc' },           // scheme 错
      { authorization: 'Bearer' },                     // 缺密钥值
      { authorization: 'secret-abc' },                 // 缺 scheme
    ];
    for (const headers of cases) {
      const res = await fetch(`${base()}/encrypt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ plaintext: 'hi' }),
      });
      assert.equal(res.status, 401, `headers=${JSON.stringify(headers)}`);
      assert.equal((await res.json()).error, 'unauthorized');
    }
    assert.equal(mock.state.encryptCalls, 0, '拒绝必须先于任何副作用');
  });

  it('正确 Bearer → 200 round-trip（scheme 大小写不敏感，RFC 6750）', async () => {
    const encRes = await fetch(`${base()}/encrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `bearer ${TOKEN}` },
      body: JSON.stringify({ plaintext: 'hi' }),
    });
    assert.equal(encRes.status, 200);
    const { data } = await encRes.json();
    const decRes = await fetch(`${base()}/decrypt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ data }),
    });
    assert.equal(decRes.status, 200);
    assert.deepEqual(await decRes.json(), { plaintext: 'hi' });
  });

  it('/health 不鉴权（只透出可用性布尔，供廉价探测）', async () => {
    const res = await fetch(`${base()}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, available: true });
  });
});
