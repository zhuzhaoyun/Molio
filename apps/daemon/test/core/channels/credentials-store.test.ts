import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configDir,
  defaultCredentialsPath,
  resolveCredentialsPath,
  readCredentials,
  writeCredentials,
  removeCredentials,
} from '../../../src/core/channels/credentials-store.js';

interface FakeCreds {
  token: string;
  baseUrl: string;
}

function validateCreds(raw: unknown): FakeCreds | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== 'string' || !r.token) return null;
  if (typeof r.baseUrl !== 'string' || !r.baseUrl) return null;
  return { token: r.token, baseUrl: r.baseUrl };
}

describe('credentials-store', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-creds-store-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('paths', () => {
    it('configDir points at ~/.molio', () => {
      assert.equal(configDir(), join(tempHome, '.molio'));
    });

    it('defaultCredentialsPath uses channel prefix', () => {
      assert.equal(
        defaultCredentialsPath('weixin'),
        join(tempHome, '.molio', 'weixin-credentials.json'),
      );
      assert.equal(
        defaultCredentialsPath('feishu'),
        join(tempHome, '.molio', 'feishu-credentials.json'),
      );
    });

    it('resolveCredentialsPath falls back to default when undefined', () => {
      assert.equal(
        resolveCredentialsPath(undefined, 'feishu'),
        join(tempHome, '.molio', 'feishu-credentials.json'),
      );
    });

    it('resolveCredentialsPath expands ~ to home dir', () => {
      const p = resolveCredentialsPath('~/custom-creds.json', 'feishu');
      assert.equal(p, join(tempHome, 'custom-creds.json'));
    });

    it('resolveCredentialsPath returns absolute path as-is', () => {
      const abs = join(tempHome, 'alt', 'creds.json');
      assert.equal(resolveCredentialsPath(abs, 'feishu'), abs);
    });
  });

  describe('readCredentials', () => {
    it('returns null when file is missing', () => {
      const file = join(tempHome, 'missing.json');
      assert.equal(readCredentials(file, validateCreds), null);
    });

    it('returns null on invalid JSON', () => {
      const file = join(tempHome, 'bad.json');
      writeFileSync(file, '{ not json', 'utf8');
      assert.equal(readCredentials(file, validateCreds), null);
    });

    it('returns null when validate returns null', () => {
      const file = join(tempHome, 'bad-shape.json');
      writeFileSync(file, JSON.stringify({ token: 'x' /* missing baseUrl */ }), 'utf8');
      assert.equal(readCredentials(file, validateCreds), null);
    });

    it('returns parsed creds when valid', () => {
      const file = join(tempHome, 'ok.json');
      writeFileSync(file, JSON.stringify({ token: 'tok-1', baseUrl: 'https://x' }), 'utf8');
      const got = readCredentials(file, validateCreds);
      assert.deepEqual(got, { token: 'tok-1', baseUrl: 'https://x' });
    });
  });

  describe('writeCredentials', () => {
    it('writes valid JSON to the target file', () => {
      const file = join(tempHome, 'out.json');
      writeCredentials(file, { token: 't', baseUrl: 'b' });
      const got = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(got, { token: 't', baseUrl: 'b' });
    });

    it('creates parent directory if missing', () => {
      const file = join(tempHome, 'deep', 'nested', 'creds.json');
      writeCredentials(file, { token: 't', baseUrl: 'b' });
      assert.ok(existsSync(file));
    });

    it('does not leave a .tmp file behind on success', () => {
      const file = join(tempHome, 'atomic.json');
      writeCredentials(file, { token: 't', baseUrl: 'b' });
      assert.ok(existsSync(file));
      assert.ok(!existsSync(`${file}.tmp`));
    });

    it('overwrites an existing file atomically (no partial state visible to readers)', () => {
      const file = join(tempHome, 'overwrite.json');
      writeCredentials(file, { token: 'old', baseUrl: 'b' });
      writeCredentials(file, { token: 'new', baseUrl: 'b' });
      const got = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(got.token, 'new');
    });

    it('preserves the previous file when write fails mid-way (tmp left behind does not corrupt target)', () => {
      const file = join(tempHome, 'preserve.json');
      writeCredentials(file, { token: 'original', baseUrl: 'b' });

      // Simulate a write failure: make the target dir read-only AFTER the original
      // is in place, then attempt writeCredentials — it should throw (rename fails
      // on read-only dir on POSIX), and the existing file must remain intact.
      // Skip on Windows where chmod doesn't enforce RO.
      if (process.platform === 'win32') {
        // On Windows chmod is a no-op for our purposes; just assert original still there.
        const got = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(got.token, 'original');
        return;
      }
      chmodSync(join(tempHome), 0o500); // dr-x------ — disallow rename into dir
      try {
        assert.throws(() => writeCredentials(file, { token: 'corrupt', baseUrl: 'b' }));
        const got = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(got.token, 'original', 'original file must be preserved');
      } finally {
        chmodSync(join(tempHome), 0o700);
      }
    });
  });

  describe('removeCredentials', () => {
    it('removes an existing file', () => {
      const file = join(tempHome, 'remove-me.json');
      writeFileSync(file, '{}', 'utf8');
      removeCredentials(file);
      assert.ok(!existsSync(file));
    });

    it('does not throw when file is missing', () => {
      const file = join(tempHome, 'never-existed.json');
      // Should not throw.
      removeCredentials(file);
      assert.ok(!existsSync(file));
    });
  });
});
