import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CRYPTO_PORT_ENV,
  CRYPTO_TOKEN_ENV,
  resolveCryptoPort,
  resolveCryptoToken,
  encryptWithDesktop,
  decryptWithDesktop,
  isDesktopCryptoConfigured,
} from '../../../src/core/auth/desktop-crypto.js';

/**
 * desktop-crypto 行为级测试：起真 node:http 假加密服务（模拟 Electron 主进程
 * crypto-server.js），覆盖成功/503/坏 JSON/超时/拒连矩阵。核心红线：任何失败
 * 都返回 null、从不抛错（token-store 依赖这个约定做降级）。
 */

type ServerMode = 'normal' | 'status503' | 'badjson' | 'wrongshape' | 'hang' | 'redirect';

interface FakeCryptoServer {
  port: number;
  setMode(m: ServerMode): void;
  /** 重定向目标地址（mode='redirect' 时 302 过去）。 */
  setRedirectTarget(url: string): void;
  /** 最近一次请求的 Authorization 头（测共享密钥透传）。 */
  lastAuth(): string | undefined;
  /** 收到的请求计数（作为重定向目标时断言"未被跟随"）。 */
  hits(): number;
  close(): Promise<void>;
}

/** 假加密 = 'fake:' + base64（确定性、可区分、可还原），与 crypto-server 同款契约。 */
function startFakeCryptoServer(): Promise<FakeCryptoServer> {
  let mode: ServerMode = 'normal';
  let redirectTarget = 'http://127.0.0.1:1/never';
  let lastAuthHeader: string | undefined;
  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount += 1;
    lastAuthHeader = req.headers.authorization;
    if (mode === 'hang') return; // 接受连接但永不响应 → 客户端超时路径
    if (mode === 'redirect') {
      res.writeHead(302, { location: redirectTarget }).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });
    req.on('end', () => {
      if (mode === 'status503') {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('crypto unavailable');
        return;
      }
      if (mode === 'badjson') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{oops not json');
        return;
      }
      if (mode === 'wrongshape') {
        // 200 + 合法 JSON，但缺约定字段（data/plaintext）
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      let parsed: { plaintext?: unknown; data?: unknown };
      try {
        parsed = JSON.parse(body) as { plaintext?: unknown; data?: unknown };
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (req.url === '/encrypt' && typeof parsed.plaintext === 'string') {
        const data = `fake:${Buffer.from(parsed.plaintext, 'utf8').toString('base64')}`;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
        return;
      }
      if (req.url === '/decrypt' && typeof parsed.data === 'string') {
        if (!parsed.data.startsWith('fake:')) {
          res.writeHead(400).end();
          return;
        }
        const plaintext = Buffer.from(parsed.data.slice('fake:'.length), 'base64').toString('utf8');
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ plaintext }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        setMode: (m) => {
          mode = m;
        },
        setRedirectTarget: (url) => {
          redirectTarget = url;
        },
        lastAuth: () => lastAuthHeader,
        hits: () => hitCount,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('desktop-crypto', () => {
  let originalPortEnv: string | undefined;

  beforeEach(() => {
    originalPortEnv = process.env[CRYPTO_PORT_ENV];
    delete process.env[CRYPTO_PORT_ENV];
  });

  afterEach(() => {
    if (originalPortEnv === undefined) delete process.env[CRYPTO_PORT_ENV];
    else process.env[CRYPTO_PORT_ENV] = originalPortEnv;
  });

  describe('resolveCryptoPort / isConfigured', () => {
    it('env 缺失 → null（dev/Docker/独立 daemon = 未配置）', () => {
      assert.equal(resolveCryptoPort({}), null);
      assert.equal(isDesktopCryptoConfigured(), false);
    });

    it('合法端口 → number', () => {
      assert.equal(resolveCryptoPort({ [CRYPTO_PORT_ENV]: '12345' }), 12345);
      process.env[CRYPTO_PORT_ENV] = '12345';
      assert.equal(isDesktopCryptoConfigured(), true);
    });

    it('非法值一律按未配置处理', () => {
      for (const bad of ['0', '-1', '65536', 'abc', '', '12.5']) {
        assert.equal(resolveCryptoPort({ [CRYPTO_PORT_ENV]: bad }), null, `bad=${JSON.stringify(bad)}`);
      }
    });
  });

  describe('未配置时（无 env）', () => {
    it('encrypt/decrypt 返回 null 且不抛错、不发网络请求', async () => {
      assert.equal(await encryptWithDesktop('hello'), null);
      assert.equal(await decryptWithDesktop('fake:aGVsbG8='), null);
    });
  });

  describe('对着真 http 假加密服务', () => {
    let fake: FakeCryptoServer;

    before(async () => {
      fake = await startFakeCryptoServer();
    });

    after(async () => {
      await fake.close();
    });

    beforeEach(() => {
      process.env[CRYPTO_PORT_ENV] = String(fake.port);
      fake.setMode('normal');
    });

    it('round-trip：encrypt → decrypt 还原一致', async () => {
      const plaintext = JSON.stringify({ accessToken: 'a', refreshToken: 'r' });
      const data = await encryptWithDesktop(plaintext);
      assert.ok(data, 'encrypt should succeed');
      assert.ok(data.startsWith('fake:'), 'ciphertext is fake-prefixed base64');
      assert.equal(await decryptWithDesktop(data), plaintext);
    });

    it('服务 503 → null（不抛错）', async () => {
      fake.setMode('status503');
      assert.equal(await encryptWithDesktop('hello'), null);
      assert.equal(await decryptWithDesktop('fake:aGVsbG8='), null);
    });

    it('服务返回坏 JSON → null（不抛错）', async () => {
      fake.setMode('badjson');
      assert.equal(await encryptWithDesktop('hello'), null);
    });

    it('服务返回 200 但缺约定字段 → null', async () => {
      fake.setMode('wrongshape');
      assert.equal(await encryptWithDesktop('hello'), null);
      assert.equal(await decryptWithDesktop('fake:aGVsbG8='), null);
    });

    it('服务挂起 → 超时后 null（2s 快失败，不阻塞登录链路）', async () => {
      fake.setMode('hang');
      const started = Date.now();
      assert.equal(await encryptWithDesktop('hello'), null);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1800 && elapsed < 10_000, `timed out at ${elapsed}ms`);
    });

    it('端口无进程监听（拒连）→ null', async () => {
      // 借一个真 server 拿空闲端口，再关掉它 → 该端口拒连
      const victim = await startFakeCryptoServer();
      const deadPort = victim.port;
      await victim.close();
      process.env[CRYPTO_PORT_ENV] = String(deadPort);
      assert.equal(await encryptWithDesktop('hello'), null);
      assert.equal(await decryptWithDesktop('fake:aGVsbG8='), null);
    });

    it('配置 CRYPTO_TOKEN 时每次调用携带 Authorization: Bearer（防本机他进程冒用）', async () => {
      const originalToken = process.env[CRYPTO_TOKEN_ENV];
      try {
        process.env[CRYPTO_TOKEN_ENV] = 'secret-abc';
        assert.equal(resolveCryptoToken(process.env), 'secret-abc');
        const data = await encryptWithDesktop('hello');
        assert.ok(data);
        assert.equal(fake.lastAuth(), 'Bearer secret-abc');
        // 纯空白按未配置（不带头）
        process.env[CRYPTO_TOKEN_ENV] = '   ';
        assert.equal(resolveCryptoToken(process.env), null);
        await encryptWithDesktop('hello');
        assert.equal(fake.lastAuth(), undefined);
      } finally {
        if (originalToken === undefined) delete process.env[CRYPTO_TOKEN_ENV];
        else process.env[CRYPTO_TOKEN_ENV] = originalToken;
      }
    });

    it('服务端 302 → redirect:error 不跟随（明文不得发往重定向目标），返回 null', async () => {
      const target = await startFakeCryptoServer();
      try {
        const before = target.hits();
        fake.setRedirectTarget(`http://127.0.0.1:${target.port}/encrypt`);
        fake.setMode('redirect');
        assert.equal(await encryptWithDesktop('hello'), null);
        assert.equal(target.hits(), before, '重定向目标不得收到请求（redirect: error 生效）');
      } finally {
        await target.close();
      }
    });
  });
});
