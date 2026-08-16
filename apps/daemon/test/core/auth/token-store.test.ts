import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthTokens, TokenCryptoProvider } from '../../../src/core/auth/token-store.js';
import {
  authTokensPath,
  readAuthTokens,
  writeAuthTokens,
  clearAuthTokens,
  decodeAccessExp,
  setTokenCryptoProvider,
} from '../../../src/core/auth/token-store.js';

/** 与 mock-cloud 同款的假 JWT（只关心 payload 可 base64url 解码）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' }), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${h}.${p}.sig`;
}

function sampleTokens(): AuthTokens {
  return {
    accessToken: fakeJwt({ sub: 'u1', exp: 1_800_000_000 }),
    refreshToken: 'refresh-1',
    user: { id: 'u1', email: 'a@b.c', createdAt: '2026-08-01T00:00:00.000Z' },
    accessExpiresAt: 1_800_000_000_000,
    savedAt: 1_799_999_100_000,
  };
}

/**
 * 行为可编程 mock crypto provider（集成测试要求：mock 行为而非只 mock 返回值）。
 * 加密 = 'enc:' + 反转字符串（确定性、可区分、可还原）；可按需切换失败模式。
 */
function makeMockCrypto(opts: { configured?: boolean } = {}) {
  const state = {
    configured: opts.configured ?? true,
    failEncrypt: false,
    failDecrypt: false,
    encryptCalls: 0,
    decryptCalls: 0,
  };
  const provider: TokenCryptoProvider = {
    isConfigured: () => state.configured,
    async encrypt(plaintext: string) {
      state.encryptCalls += 1;
      if (state.failEncrypt) return null;
      return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
    },
    async decrypt(data: string) {
      state.decryptCalls += 1;
      if (state.failDecrypt) return null;
      if (!data.startsWith('enc:')) return null; // 不是本 provider 加密的（跨机器）
      return Buffer.from(data.slice('enc:'.length), 'base64').toString('utf8');
    },
  };
  return { state, provider };
}

describe('auth token-store', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let restoreProvider: (() => void) | null = null;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-auth-token-store-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    mkdirSync(join(tempHome, '.molio'), { recursive: true });
  });

  afterEach(() => {
    if (restoreProvider) {
      restoreProvider();
      restoreProvider = null;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('path is ~/.molio/auth-tokens.json (NOT config.json)', () => {
    assert.equal(authTokensPath(), join(tempHome, '.molio', 'auth-tokens.json'));
  });

  it('write → read round-trip (plaintext mode, crypto unconfigured)', async () => {
    const tokens = sampleTokens();
    const result = await writeAuthTokens(tokens);
    assert.deepEqual(result, { written: true, encrypted: false });
    const read = await readAuthTokens();
    assert.deepEqual(read, tokens);
  });

  it('read returns null when file missing', async () => {
    assert.equal(await readAuthTokens(), null);
  });

  it('read returns null on corrupted JSON', async () => {
    writeFileSync(authTokensPath(), '{not json', 'utf8');
    assert.equal(await readAuthTokens(), null);
  });

  it('read returns null when required fields are missing', async () => {
    writeFileSync(
      authTokensPath(),
      JSON.stringify({ accessToken: 'a', user: { id: 'u1' } }),
      'utf8',
    );
    assert.equal(await readAuthTokens(), null);
  });

  it('clearAuthTokens removes the file and read returns null', async () => {
    await writeAuthTokens(sampleTokens());
    assert.ok(existsSync(authTokensPath()));
    clearAuthTokens();
    assert.ok(!existsSync(authTokensPath()));
    assert.equal(await readAuthTokens(), null);
  });

  it('clearAuthTokens never throws when file missing', () => {
    assert.doesNotThrow(() => clearAuthTokens());
  });

  // Windows 上 chmod 无意义（设计 §八 D3：与 SQLite/config 同信任级）
  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('file is chmod 600 on POSIX', async () => {
    await writeAuthTokens(sampleTokens());
    const mode = statSync(authTokensPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  describe('desktop crypto (envelope) mode', () => {
    it('round-trip: writes envelope without plaintext secrets, reads back equal', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      const tokens = sampleTokens();

      const result = await writeAuthTokens(tokens);
      assert.deepEqual(result, { written: true, encrypted: true });

      // 磁盘上是信封，无明文 token
      const raw = JSON.parse(readFileSync(authTokensPath(), 'utf8')) as Record<string, unknown>;
      assert.equal(raw.v, 1);
      assert.equal(typeof raw.encrypted, 'string');
      assert.ok(!('accessToken' in raw));
      const fileText = readFileSync(authTokensPath(), 'utf8');
      assert.ok(!fileText.includes(tokens.refreshToken));
      assert.ok(!fileText.includes(tokens.user.email));

      // （模拟重启后）重读还原一致
      assert.deepEqual(await readAuthTokens(), tokens);
      assert.equal(mock.state.decryptCalls, 1);
    });

    it('legacy plaintext file reads fine in desktop mode; next write upgrades to envelope', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      const tokens = sampleTokens();
      writeFileSync(authTokensPath(), JSON.stringify(tokens, null, 2), 'utf8'); // M2 旧格式

      assert.deepEqual(await readAuthTokens(), tokens);

      const result = await writeAuthTokens(tokens);
      assert.deepEqual(result, { written: true, encrypted: true });
      const raw = JSON.parse(readFileSync(authTokensPath(), 'utf8')) as Record<string, unknown>;
      assert.equal(raw.v, 1);
      assert.deepEqual(await readAuthTokens(), tokens);
    });

    it('envelope + crypto service down: read null, file PRESERVED (recoverable)', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      const tokens = sampleTokens();
      await writeAuthTokens(tokens);
      assert.ok(existsSync(authTokensPath()));

      mock.state.failDecrypt = true; // 服务暂挂
      assert.equal(await readAuthTokens(), null);
      assert.ok(existsSync(authTokensPath()), 'file must NOT be deleted');

      mock.state.failDecrypt = false; // 服务恢复
      assert.deepEqual(await readAuthTokens(), tokens);
    });

    it('envelope from another machine (decrypt fails): treated as logged-out, file kept', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      // 手工伪造一个本 provider 解不了的信封（跨机器复制场景）
      writeFileSync(
        authTokensPath(),
        JSON.stringify({ v: 1, encrypted: 'foreign-machine-blob' }),
        'utf8',
      );
      assert.equal(await readAuthTokens(), null);
      assert.ok(existsSync(authTokensPath()));
    });

    it('envelope + crypto UNCONFIGURED (standalone daemon): read null, file kept; new login overwrites plaintext', async () => {
      // 先以桌面模式写信封
      const desktop = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(desktop.provider);
      await writeAuthTokens(sampleTokens());

      // 切到独立 daemon（无 crypto）：读不了信封 → 未登录
      const standalone = makeMockCrypto({ configured: false });
      restoreProvider = setTokenCryptoProvider(standalone.provider);
      assert.equal(await readAuthTokens(), null);
      assert.ok(existsSync(authTokensPath()));

      // 新登录 → 明文覆盖（独立 daemon 合法基线，D3）
      const fresh = sampleTokens();
      fresh.refreshToken = 'refresh-standalone';
      const result = await writeAuthTokens(fresh);
      assert.deepEqual(result, { written: true, encrypted: false });
      assert.deepEqual(await readAuthTokens(), fresh);
    });

    it('encrypt failure: disk write SKIPPED (never downgrade to plaintext), memory kept by caller', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      await writeAuthTokens(sampleTokens());
      const beforeRaw = readFileSync(authTokensPath(), 'utf8');

      mock.state.failEncrypt = true; // crypto 服务暂挂
      const result = await writeAuthTokens({ ...sampleTokens(), refreshToken: 'refresh-new' });
      assert.deepEqual(result, { written: false, reason: 'encrypt_failed' });

      // 磁盘仍是旧信封，绝不出现明文
      assert.equal(readFileSync(authTokensPath(), 'utf8'), beforeRaw);
      assert.ok(!beforeRaw.includes('refresh-new'));

      mock.state.failEncrypt = false; // 恢复后可正常落盘
      const retry = await writeAuthTokens({ ...sampleTokens(), refreshToken: 'refresh-new' });
      assert.deepEqual(retry, { written: true, encrypted: true });
    });

    it('inner plaintext that fails JSON parse → null (defensive)', async () => {
      const mock = makeMockCrypto();
      restoreProvider = setTokenCryptoProvider(mock.provider);
      // 用 provider 直接加密一段坏 JSON，绕过 writeAuthTokens
      const badData = await mock.provider.encrypt('{not valid json');
      writeFileSync(authTokensPath(), JSON.stringify({ v: 1, encrypted: badData }), 'utf8');
      assert.equal(await readAuthTokens(), null);
    });
  });

  it('numeric fields must be finite: Infinity/NaN in savedAt/accessExpiresAt are rejected', async () => {
    // 手写 JSON（JSON.stringify 会把 Infinity 折成 null，构造不出该路径）
    writeFileSync(
      authTokensPath(),
      '{"accessToken":"a","refreshToken":"b","user":{"id":"u1","email":"a@b.c","createdAt":"2026-08-01T00:00:00.000Z"},"savedAt":1e999,"accessExpiresAt":1e999}',
      'utf8',
    );
    const read = await readAuthTokens();
    assert.ok(read, 'tokens 本体仍有效');
    assert.equal(read!.savedAt, 0, 'Infinity savedAt → 0');
    assert.equal(read!.accessExpiresAt, undefined, 'Infinity exp → 缺省（否则永不过期）');
  });

  describe('decodeAccessExp', () => {
    /** 手写 payload JSON 的 JWT（JSON.stringify 无法表达 1e999 这类值）。 */
    function rawJwt(payloadJson: string): string {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256' }), 'utf8').toString('base64url');
      const p = Buffer.from(payloadJson, 'utf8').toString('base64url');
      return `${h}.${p}.sig`;
    }

    it('decodes exp to unix ms', () => {
      const jwt = fakeJwt({ sub: 'u1', exp: 1_800_000_000 });
      assert.equal(decodeAccessExp(jwt), 1_800_000_000_000);
    });

    it('returns null for non-JWT garbage', () => {
      assert.equal(decodeAccessExp('opaque-token'), null);
      assert.equal(decodeAccessExp(''), null);
    });

    it('returns null when payload is not base64url JSON', () => {
      assert.equal(decodeAccessExp('a.!!!.c'), null);
    });

    it('returns null when exp missing or not a number', () => {
      assert.equal(decodeAccessExp(fakeJwt({ sub: 'u1' })), null);
      assert.equal(decodeAccessExp(fakeJwt({ sub: 'u1', exp: 'soon' })), null);
    });

    it('returns null for non-positive exp（永久已过期 → 每次请求抢跑刷新）', () => {
      assert.equal(decodeAccessExp(fakeJwt({ sub: 'u1', exp: 0 })), null);
      assert.equal(decodeAccessExp(fakeJwt({ sub: 'u1', exp: -100 })), null);
    });

    it('returns null when exp*1000 overflows to Infinity（永不过期漏洞）', () => {
      assert.equal(decodeAccessExp(rawJwt('{"sub":"u1","exp":1e999}')), null);
      assert.equal(decodeAccessExp(rawJwt('{"sub":"u1","exp":1e306}')), null);
    });
  });

  describe('write/clear 序列化（登出竞态）', () => {
    it('加密在途时 clearAuthTokens → 写入放弃（superseded），已删文件不复活', async () => {
      let releaseEncrypt!: () => void;
      const gate = new Promise<void>((r) => (releaseEncrypt = r));
      const stalling: TokenCryptoProvider = {
        isConfigured: () => true,
        async encrypt(plaintext: string) {
          await gate;
          return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
        },
        async decrypt(data: string) {
          if (!data.startsWith('enc:')) return null;
          return Buffer.from(data.slice('enc:'.length), 'base64').toString('utf8');
        },
      };
      restoreProvider = setTokenCryptoProvider(stalling);

      const writeP = writeAuthTokens(sampleTokens()); // 挂住在途加密
      clearAuthTokens(); // 登出：generation+1 + 删文件
      releaseEncrypt();

      const result = await writeP;
      assert.deepEqual(result, { written: false, reason: 'superseded' });
      assert.ok(!existsSync(authTokensPath()), '放弃的写入不得复活已删文件（否则重启后旧 token 复活）');
      assert.equal(await readAuthTokens(), null);
    });

    it('clear 之后的新写入不受影响（generation 只作废在途写）', async () => {
      let releaseEncrypt!: () => void;
      const gate = new Promise<void>((r) => (releaseEncrypt = r));
      let gating = true;
      const stalling: TokenCryptoProvider = {
        isConfigured: () => true,
        async encrypt(plaintext: string) {
          if (gating) await gate;
          return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
        },
        async decrypt(data: string) {
          if (!data.startsWith('enc:')) return null;
          return Buffer.from(data.slice('enc:'.length), 'base64').toString('utf8');
        },
      };
      restoreProvider = setTokenCryptoProvider(stalling);

      const staleP = writeAuthTokens(sampleTokens());
      clearAuthTokens();
      gating = false;
      releaseEncrypt();
      assert.deepEqual(await staleP, { written: false, reason: 'superseded' });

      const fresh = sampleTokens();
      fresh.refreshToken = 'refresh-after-relogin';
      assert.deepEqual(await writeAuthTokens(fresh), { written: true, encrypted: true });
      assert.equal((await readAuthTokens())?.refreshToken, 'refresh-after-relogin');
    });
  });
});
