import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthTokens } from '../../../src/core/auth/token-store.js';
import {
  authTokensPath,
  readAuthTokens,
  writeAuthTokens,
  clearAuthTokens,
  decodeAccessExp,
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

describe('auth token-store', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-auth-token-store-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    mkdirSync(join(tempHome, '.molio'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('path is ~/.molio/auth-tokens.json (NOT config.json)', () => {
    assert.equal(authTokensPath(), join(tempHome, '.molio', 'auth-tokens.json'));
  });

  it('write → read round-trip', () => {
    const tokens = sampleTokens();
    writeAuthTokens(tokens);
    const read = readAuthTokens();
    assert.deepEqual(read, tokens);
  });

  it('read returns null when file missing', () => {
    assert.equal(readAuthTokens(), null);
  });

  it('read returns null on corrupted JSON', () => {
    writeFileSync(authTokensPath(), '{not json', 'utf8');
    assert.equal(readAuthTokens(), null);
  });

  it('read returns null when required fields are missing', () => {
    writeFileSync(
      authTokensPath(),
      JSON.stringify({ accessToken: 'a', user: { id: 'u1' } }),
      'utf8',
    );
    assert.equal(readAuthTokens(), null);
  });

  it('clearAuthTokens removes the file and read returns null', () => {
    writeAuthTokens(sampleTokens());
    assert.ok(existsSync(authTokensPath()));
    clearAuthTokens();
    assert.ok(!existsSync(authTokensPath()));
    assert.equal(readAuthTokens(), null);
  });

  it('clearAuthTokens never throws when file missing', () => {
    assert.doesNotThrow(() => clearAuthTokens());
  });

  // Windows 上 chmod 无意义（设计 §八 D3：与 SQLite/config 同信任级）
  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('file is chmod 600 on POSIX', () => {
    writeAuthTokens(sampleTokens());
    const mode = statSync(authTokensPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  describe('decodeAccessExp', () => {
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
  });
});
