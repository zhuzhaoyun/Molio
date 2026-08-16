import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EntitlementCache,
  DEFAULT_GRACE_DAYS,
  type EntitlementSnapshot,
} from '../../../src/core/auth/entitlement-cache.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function snap(updatedAt: number): EntitlementSnapshot {
  return {
    user: { id: 'u1', email: 'a@b.c', createdAt: '2026-08-01T00:00:00.000Z' },
    entitlement: { plan: 'pro' },
    updatedAt,
  };
}

describe('EntitlementCache', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalGraceEnv: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'molio-entitlement-cache-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalGraceEnv = process.env.MOLIO_AUTH_GRACE_DAYS;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.MOLIO_AUTH_GRACE_DAYS;
    mkdirSync(join(tempHome, '.molio'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    if (originalGraceEnv === undefined) delete process.env.MOLIO_AUTH_GRACE_DAYS;
    else process.env.MOLIO_AUTH_GRACE_DAYS = originalGraceEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('defaults: file under ~/.molio + 7 day grace', () => {
    const cache = new EntitlementCache();
    assert.equal(cache.graceMs, DEFAULT_GRACE_DAYS * DAY_MS);
    cache.write(snap(NOW));
    assert.ok(existsSync(join(tempHome, '.molio', 'entitlement-cache.json')));
  });

  it('write → read round-trip (fresh instance reads from disk)', () => {
    new EntitlementCache().write(snap(NOW));
    const read = new EntitlementCache().read();
    assert.deepEqual(read, snap(NOW));
  });

  it('read returns null when missing / corrupted', () => {
    assert.equal(new EntitlementCache().read(), null);
    writeFileSync(join(tempHome, '.molio', 'entitlement-cache.json'), '{bad', 'utf8');
    assert.equal(new EntitlementCache().read(), null);
  });

  it('clear removes disk + memory copy', () => {
    const cache = new EntitlementCache();
    cache.write(snap(NOW));
    cache.clear();
    assert.equal(cache.read(), null);
    assert.equal(new EntitlementCache().read(), null);
  });

  it('snapshot updatedAt 必须有限正数：1e999（Infinity）= 永久宽限漏洞 → 拒读', () => {
    // 手写 JSON（JSON.stringify 会把 Infinity 折成 null）
    const file = join(tempHome, '.molio', 'entitlement-cache.json');
    writeFileSync(
      file,
      '{"user":{"id":"u1","email":"a@b.c","createdAt":"2026-08-01T00:00:00.000Z"},"entitlement":{"plan":"pro"},"updatedAt":1e999}',
      'utf8',
    );
    assert.equal(new EntitlementCache().read(), null);
    writeFileSync(
      file,
      '{"user":{"id":"u1","email":"a@b.c","createdAt":"2026-08-01T00:00:00.000Z"},"entitlement":{},"updatedAt":-5}',
      'utf8',
    );
    assert.equal(new EntitlementCache().read(), null);
  });

  describe('grace window', () => {
    it('within grace just before expiry, out just after', () => {
      const cache = new EntitlementCache({ graceDays: 7 });
      const s = snap(NOW);
      assert.equal(cache.isWithinGrace(s, NOW + 7 * DAY_MS - 1), true);
      assert.equal(cache.isWithinGrace(s, NOW + 7 * DAY_MS), false);
    });

    it('graceRemainingMs counts down', () => {
      const cache = new EntitlementCache({ graceDays: 1 });
      const s = snap(NOW);
      assert.equal(cache.graceRemainingMs(s, NOW), DAY_MS);
      assert.equal(cache.graceRemainingMs(s, NOW + DAY_MS / 2), DAY_MS / 2);
      assert.ok(cache.graceRemainingMs(s, NOW + DAY_MS + 1) <= 0);
    });

    it('MOLIO_AUTH_GRACE_DAYS env overrides default', () => {
      process.env.MOLIO_AUTH_GRACE_DAYS = '2';
      const cache = new EntitlementCache();
      assert.equal(cache.graceMs, 2 * DAY_MS);
    });

    it('invalid env falls back to default', () => {
      process.env.MOLIO_AUTH_GRACE_DAYS = 'not-a-number';
      const cache = new EntitlementCache();
      assert.equal(cache.graceMs, DEFAULT_GRACE_DAYS * DAY_MS);
    });

    it("env '0.5' 不再取整成 0（会静默关死宽限）——非整数一律回退默认", () => {
      process.env.MOLIO_AUTH_GRACE_DAYS = '0.5';
      assert.equal(new EntitlementCache().graceMs, DEFAULT_GRACE_DAYS * DAY_MS);
    });

    it("env '1e308' 防溢出——graceMs 不得变 Infinity（永久白嫖）", () => {
      process.env.MOLIO_AUTH_GRACE_DAYS = '1e308';
      const cache = new EntitlementCache();
      assert.equal(cache.graceMs, DEFAULT_GRACE_DAYS * DAY_MS);
      assert.ok(Number.isFinite(cache.graceMs));
    });

    it('constructor graceDays beats env', () => {
      process.env.MOLIO_AUTH_GRACE_DAYS = '2';
      const cache = new EntitlementCache({ graceDays: 3 });
      assert.equal(cache.graceMs, 3 * DAY_MS);
    });

    it('constructor graceDays 非法（0/0.5/Infinity）→ RangeError（显式传参是编程错误）', () => {
      assert.throws(() => new EntitlementCache({ graceDays: 0 }), RangeError);
      assert.throws(() => new EntitlementCache({ graceDays: 0.5 }), RangeError);
      assert.throws(() => new EntitlementCache({ graceDays: Infinity }), RangeError);
    });
  });
});
