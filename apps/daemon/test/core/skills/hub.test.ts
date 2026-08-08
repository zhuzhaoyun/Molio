import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zipSync } from 'fflate';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../../src/core/db.js';
import {
  extractSkillZip,
  installHubSkill,
  getHubInstall,
  fetchHubSkills,
  fetchHubCategories,
  HubError,
  _setHubFetchForTests,
} from '../../../src/core/skills/hub.js';
import { toggleSkill } from '../../../src/core/skills/store.js';
import { skillContentDir, type SkillPathsOpts } from '../../../src/core/skills/paths.js';
import { MAX_IMPORT_FILES } from '../../../src/core/skills/importer.js';

/**
 * Skill hub client tests. Network access is faked via _setHubFetchForTests:
 * the download endpoint serves zips built in-test with fflate, so the full
 * install pipeline (download → extract → import → hub record) runs hermetically.
 */

let molioHome: string;
let claudeHome: string;
let dbDir: string;
let db: Database.Database;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-claude-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-db-'));
  db = openDatabase(dbDir);
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  _setHubFetchForTests();
  closeDatabase();
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a real zip from a {path: textContent} map. */
function zipOf(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = utf8(content);
  return zipSync(entries);
}

const SKILL_MD = (body: string, version = '1.0.0') =>
  `---\nname: 测试技能\ndescription: 商店安装测试\nversion: ${version}\n---\n\n${body}\n`;

/** Fake fetch: /api/v1/download serves `zip`; everything else 404s. */
function serveZip(zip: Uint8Array): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/v1/download')) {
      return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('skills/hub — extractSkillZip', () => {
  it('extracts a multi-file package preserving nested dirs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      const zip = zipOf({
        'SKILL.md': SKILL_MD('正文'),
        '_meta.json': JSON.stringify({ slug: 'x', version: '2.0.0' }),
        'references/guide.md': 'guide',
      });
      extractSkillZip(zip, dir);
      assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
      assert.equal(fs.readFileSync(path.join(dir, 'references', 'guide.md'), 'utf8'), 'guide');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects zip-slip entries (../ traversal)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      const zip = zipOf({ 'SKILL.md': 'ok', '../evil.md': 'pwned' });
      assert.throws(() => extractSkillZip(zip, dir), (err: unknown) => {
        return err instanceof HubError && err.code === 'BAD_REQUEST' && /不安全/.test(err.message);
      });
      assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects non-zip bytes and empty archives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      assert.throws(() => extractSkillZip(utf8('hello world'), dir), (err: unknown) => {
        return err instanceof HubError && err.code === 'BAD_REQUEST' && /zip/.test(err.message);
      });
      assert.throws(() => extractSkillZip(zipOf({}), dir), (err: unknown) => {
        return err instanceof HubError && /空/.test(err.message);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the import file-count limit during extraction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      const files: Record<string, string> = {};
      for (let i = 0; i <= MAX_IMPORT_FILES; i += 1) files[`f${i}.txt`] = 'x';
      const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, utf8(v)])));
      assert.throws(() => extractSkillZip(zip, dir), (err: unknown) => {
        return err instanceof HubError && err.code === 'BAD_REQUEST' && /文件数/.test(err.message);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps UNCOMPRESSED bytes mid-stream (zip-bomb guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      // 200 KB of zeros compresses to a few hundred bytes — far under any
      // download cap — but must still be rejected once the cumulative
      // decompressed size crosses the limit. This is the exact shape of a
      // zip bomb, and the check runs on bytes actually produced, not on the
      // (forgeable) size fields in the zip header.
      const bomb = zipSync({ 'SKILL.md': new Uint8Array(200 * 1024) });
      assert.ok(bomb.length < 5 * 1024); // sanity: compression ratio is huge
      assert.throws(
        () => extractSkillZip(bomb, dir, { maxFiles: 100, maxBytes: 10 * 1024 }),
        (err: unknown) => {
          return err instanceof HubError && err.code === 'BAD_REQUEST' && /过大/.test(err.message);
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a truncated archive (silent partial decode guard)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-hub-extract-'));
    try {
      const zip = zipOf({ 'SKILL.md': 'ok', 'references/guide.md': 'guide content' });
      // Chop the tail: kills the end-of-central-directory record.
      const truncated = zip.subarray(0, Math.floor(zip.length / 2));
      assert.throws(() => extractSkillZip(truncated, dir), (err: unknown) => {
        return err instanceof HubError && err.code === 'BAD_REQUEST';
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skills/hub — installHubSkill', () => {
  it('installs a fresh hub skill through the import pipeline', async () => {
    const zip = zipOf({
      'SKILL.md': SKILL_MD('见 references/guide.md', '2.0.0'),
      '_meta.json': JSON.stringify({ slug: 'demo', version: '2.0.0' }),
      'references/guide.md': 'detailed guide',
    });
    _setHubFetchForTests(serveZip(zip));

    const result = await installHubSkill(db, { slug: 'demo' }, opts);
    assert.equal(result.updated, false);
    assert.equal(result.version, '2.0.0'); // from _meta.json
    assert.equal(result.skill.name, '测试技能');
    assert.equal(result.skill.kind, 'library');
    assert.equal(result.skill.enabled, true);

    // Multi-file content landed in the library dir.
    const contentDir = skillContentDir(result.skill.id, opts);
    assert.ok(fs.existsSync(path.join(contentDir, 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(contentDir, 'references', 'guide.md'), 'utf8'), 'detailed guide');

    // Install registry maps (namespace, slug) → skill id ('' namespace here).
    const rec = getHubInstall(db, 'demo', '');
    assert.ok(rec);
    assert.equal(rec.skill_id, result.skill.id);
    assert.equal(rec.version, '2.0.0');
  });

  it('reinstall refreshes the SAME skill in place and keeps its toggle state', async () => {
    _setHubFetchForTests(serveZip(zipOf({
      'SKILL.md': SKILL_MD('旧版正文', '1.0.0'),
      '_meta.json': JSON.stringify({ slug: 'demo', version: '1.0.0' }),
      'references/stale.md': 'only in the old version',
    })));
    const first = await installHubSkill(db, { slug: 'demo' }, opts);
    // The user disables the skill, then an update arrives — the state must survive.
    toggleSkill(db, first.skill.id, false);

    _setHubFetchForTests(serveZip(zipOf({
      'SKILL.md': SKILL_MD('新版正文', '1.1.0'),
      '_meta.json': JSON.stringify({ slug: 'demo', version: '1.1.0' }),
      'references/new.md': 'added later',
    })));
    const second = await installHubSkill(db, { slug: 'demo' }, opts);

    assert.equal(second.updated, true);
    assert.equal(second.version, '1.1.0');
    assert.equal(second.skill.id, first.skill.id); // same row, no duplicate
    assert.equal(second.skill.enabled, false); // toggle preserved

    const contentDir = skillContentDir(first.skill.id, opts);
    assert.match(fs.readFileSync(path.join(contentDir, 'SKILL.md'), 'utf8'), /新版正文/);
    assert.ok(fs.existsSync(path.join(contentDir, 'references', 'new.md')));
    // Whole-tree mirror: files that vanished from the package vanish too.
    assert.ok(!fs.existsSync(path.join(contentDir, 'references', 'stale.md')));

    // Still exactly one install record and one skill row for the slug.
    assert.ok(getHubInstall(db, 'demo', ''));
    const rows = db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number };
    assert.equal(rows.n, 1);
  });

  it('same slug in different namespaces installs as two separate skills', async () => {
    // The download stub varies the package by namespace so each install's
    // content is distinguishable.
    _setHubFetchForTests((async (input: unknown) => {
      const url = String(input);
      if (!url.includes('/api/v1/download')) return new Response('not found', { status: 404 });
      const ns = new URL(url).searchParams.get('namespace') ?? 'unnamed';
      const zip = zipOf({
        'SKILL.md': SKILL_MD(`正文来自 ${ns}`, '1.0.0'),
        '_meta.json': JSON.stringify({ slug: 'demo', version: '1.0.0' }),
      });
      return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }) as typeof fetch);

    const alice = await installHubSkill(db, { slug: 'demo', namespace: 'alice' }, opts);
    const bob = await installHubSkill(db, { slug: 'demo', namespace: 'bob' }, opts);
    assert.equal(alice.updated, false);
    assert.equal(bob.updated, false);
    assert.notEqual(alice.skill.id, bob.skill.id); // no silent overwrite

    assert.ok(getHubInstall(db, 'demo', 'alice'));
    assert.ok(getHubInstall(db, 'demo', 'bob'));
    assert.equal(getHubInstall(db, 'demo', ''), null); // namespaces don't leak

    // Refreshing alice's install leaves bob's content untouched.
    const again = await installHubSkill(db, { slug: 'demo', namespace: 'alice' }, opts);
    assert.equal(again.updated, true);
    assert.equal(again.skill.id, alice.skill.id);
    const bobDir = skillContentDir(bob.skill.id, opts);
    assert.match(fs.readFileSync(path.join(bobDir, 'SKILL.md'), 'utf8'), /正文来自 bob/);
  });

  it('concurrent installs of the same (namespace, slug) share one run', async () => {
    _setHubFetchForTests(serveZip(zipOf({
      'SKILL.md': SKILL_MD('并发安装', '1.0.0'),
      '_meta.json': JSON.stringify({ slug: 'demo', version: '1.0.0' }),
    })));

    // Fired back-to-back without awaiting: the second call must join the
    // in-flight run instead of racing the install registry.
    const [r1, r2] = await Promise.all([
      installHubSkill(db, { slug: 'demo', namespace: 'alice' }, opts),
      installHubSkill(db, { slug: 'demo', namespace: 'alice' }, opts),
    ]);
    assert.equal(r1.skill.id, r2.skill.id);
    assert.equal(r1.updated, false);

    const rows = db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number };
    assert.equal(rows.n, 1); // exactly one skill row, no orphaned duplicate
  });

  it('rejects invalid namespaces', async () => {
    await assert.rejects(
      installHubSkill(db, { slug: 'demo', namespace: '../evil' }, opts),
      (err: unknown) => err instanceof HubError && err.code === 'BAD_REQUEST',
    );
  });

  it('rejects invalid slugs and packages without SKILL.md', async () => {
    _setHubFetchForTests(serveZip(zipOf({ 'README.md': 'no skill here' })));

    await assert.rejects(installHubSkill(db, { slug: '../etc' }, opts), (err: unknown) => {
      return err instanceof HubError && err.code === 'BAD_REQUEST';
    });
    await assert.rejects(installHubSkill(db, { slug: 'no-skill-md' }, opts), (err: unknown) => {
      return err instanceof HubError && /SKILL\.md/.test((err as Error).message);
    });
  });

  it('maps a hub download 404 to NOT_FOUND', async () => {
    _setHubFetchForTests((async () => new Response('missing', { status: 404 })) as typeof fetch);
    await assert.rejects(installHubSkill(db, { slug: 'ghost' }, opts), (err: unknown) => {
      return err instanceof HubError && err.code === 'NOT_FOUND';
    });
  });
});

describe('skills/hub — catalog fetch mapping', () => {
  function serveJson(payload: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
  }

  it('fetchHubSkills maps records (zh description, labels, namespace)', async () => {
    _setHubFetchForTests(serveJson({
      code: 0,
      message: 'success',
      data: {
        total: 2,
        skills: [
          {
            slug: 'demo',
            name: 'Demo',
            description: 'english only',
            description_zh: '中文描述',
            version: '1.2.3',
            downloads: 42,
            ownerName: 'alice',
            verified: true,
            category: 'office-efficiency',
            labels: { requires_api_key: 'true' },
            namespace: { handle: 'alice' },
            updated_at: 1786000000000,
          },
          { slug: 'bare', name: 'Bare' },
        ],
      },
    }));
    const result = await fetchHubSkills({ page: 1, pageSize: 20, keyword: 'pdf' });
    assert.equal(result.total, 2);
    const [a, b] = result.skills;
    assert.ok(a && b);
    assert.equal(a.description, '中文描述'); // zh wins
    assert.equal(a.requiresApiKey, true);
    assert.equal(a.namespace, 'alice');
    assert.equal(a.verified, true);
    assert.equal(b.description, ''); // all fields optional
    assert.equal(b.requiresApiKey, false);
    assert.equal(b.namespace, undefined);
  });

  it('fetchHubSkills rejects a non-zero envelope code', async () => {
    _setHubFetchForTests(serveJson({ code: 500, message: 'boom', data: null }));
    await assert.rejects(fetchHubSkills({}), (err: unknown) => {
      return err instanceof HubError && err.code === 'HUB_UNAVAILABLE';
    });
  });

  it('fetchHubCategories filters inactive and sorts by sortOrder', async () => {
    _setHubFetchForTests(serveJson({
      count: 3,
      items: [
        { key: 'b', name: '乙', sortOrder: 20, active: true },
        { key: 'off', name: '隐藏', sortOrder: 0, active: false },
        { key: 'a', name: '甲', sortOrder: 10, active: true },
      ],
    }));
    const categories = await fetchHubCategories();
    assert.deepEqual(categories, [
      { key: 'a', name: '甲' },
      { key: 'b', name: '乙' },
    ]);
  });
});
