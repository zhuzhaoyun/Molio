import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { zipSync } from 'fflate';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { skillsRoutes } from '../../src/routes/skills.js';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { _setHubFetchForTests } from '../../src/core/skills/hub.js';
import type { HubSkillsListResponse, InstallHubSkillResponse, SkillListResponse, SkillManifestEntry } from '@molio/contracts';

/**
 * Hub route tests. Same isolation as skills.test.ts: HOME points at a temp dir
 * (the install pipeline resolves ~/.molio from os.homedir) and the hub itself
 * is faked via _setHubFetchForTests — no network involved.
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const fakeRunManager = {
  createRun: () => Promise.reject(new Error('no agent installed')),
  onEvent: () => null,
  cancelRun: () => {},
};

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

const SKILL_MD = (body: string, version: string) =>
  `---\nname: 商店技能\ndescription: 来自商店\nversion: ${version}\n---\n\n${body}\n`;

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, utf8(v)])));
}

/**
 * Fake hub: catalog list + categories + zip download. `failAll` flips every
 * request into a network error to exercise the 502 mapping.
 */
function fakeHubFetch(opts: { failAll?: boolean } = {}): typeof fetch {
  return (async (input: unknown) => {
    if (opts.failAll) throw new Error('ECONNREFUSED (fake)');
    const url = String(input);
    if (url.includes('/api/skills?')) {
      return new Response(
        JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            total: 2,
            skills: [
              {
                slug: 'alpha-skill',
                name: 'Alpha',
                description: 'alpha skill',
                description_zh: '阿尔法技能',
                version: '1.0.0',
                downloads: 10,
                ownerName: 'alice',
                category: 'office-efficiency',
                labels: { requires_api_key: 'false' },
                updated_at: 1786000000000,
              },
              { slug: 'beta-skill', name: 'Beta', description: 'beta skill' },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/categories')) {
      return new Response(
        JSON.stringify({ count: 1, items: [{ key: 'office-efficiency', name: '办公效率', active: true, sortOrder: 10 }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/api/v1/download')) {
      if (!url.includes('slug=alpha-skill')) {
        return new Response('missing', { status: 404 });
      }
      const zip = zipOf({
        'SKILL.md': SKILL_MD('商店技能正文', '1.0.0'),
        '_meta.json': JSON.stringify({ slug: 'alpha-skill', version: '1.0.0' }),
      });
      return new Response(zip, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('Skills hub routes', () => {
  let app: Hono;
  let db: Database.Database;
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-hub-routes-home-'));
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;

    db = openDatabase(join(home, 'dbdata'));
    _setHubFetchForTests(fakeHubFetch());

    const root = new Hono();
    root.route('/api/skills', skillsRoutes(db, fakeRunManager as never));
    app = root;
  });

  after(() => {
    _setHubFetchForTests();
    closeDatabase();
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('GET /hub/skills maps the catalog and starts uninstalled', async () => {
    const res = await app.request('/api/skills/hub/skills?page=1&pageSize=20&keyword=alpha');
    assert.equal(res.status, 200);
    const body = (await json(res)) as unknown as HubSkillsListResponse;
    assert.equal(body.total, 2);
    assert.equal(body.skills.length, 2);
    const alpha = body.skills.find((s) => s.slug === 'alpha-skill');
    assert.ok(alpha);
    assert.equal(alpha.description, '阿尔法技能');
    assert.equal(alpha.ownerName, 'alice');
    assert.notEqual(alpha.installed, true);
  });

  it('GET /hub/categories returns the mapped category list', async () => {
    const res = await app.request('/api/skills/hub/categories');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body['categories'], [{ key: 'office-efficiency', name: '办公效率' }]);
  });

  it('POST /hub/install requires a slug', async () => {
    const res = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('POST /hub/install installs into the library and marks the catalog entry', async () => {
    const res = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'alpha-skill' }),
    });
    assert.equal(res.status, 201);
    const body = (await json(res)) as unknown as InstallHubSkillResponse;
    assert.equal(body.updated, false);
    assert.equal(body.version, '1.0.0');
    assert.equal(body.skill.name, '商店技能');
    assert.equal(body.skill.enabled, true);

    // The skill now shows up in the user library…
    const list = (await json(await app.request('/api/skills'))) as unknown as SkillListResponse;
    assert.ok(list.skills.some((s) => s.id === body.skill.id));

    // …and the catalog entry is annotated as installed.
    const hub = (await json(await app.request('/api/skills/hub/skills'))) as unknown as HubSkillsListResponse;
    const alpha = hub.skills.find((s) => s.slug === 'alpha-skill');
    assert.ok(alpha);
    assert.equal(alpha.installed, true);
    assert.equal(alpha.installedVersion, '1.0.0');
  });

  it('POST /hub/install again refreshes the same skill (updated=true)', async () => {
    const res = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'alpha-skill' }),
    });
    assert.equal(res.status, 201);
    const body = (await json(res)) as unknown as InstallHubSkillResponse;
    assert.equal(body.updated, true);

    // No duplicate row in the library.
    const list = (await json(await app.request('/api/skills'))) as unknown as SkillListResponse;
    assert.equal(list.skills.filter((s) => s.name === '商店技能').length, 1);
  });

  it('POST /hub/install maps an unknown slug to 404', async () => {
    const res = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'ghost-skill' }),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE removes the skill AND clears the installed annotation', async () => {
    const list = (await json(await app.request('/api/skills'))) as unknown as SkillListResponse;
    const installed = list.skills.find((s) => s.name === '商店技能');
    assert.ok(installed);

    const del = await app.request(`/api/skills/${installed.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const hub = (await json(await app.request('/api/skills/hub/skills'))) as unknown as HubSkillsListResponse;
    const alpha = hub.skills.find((s) => s.slug === 'alpha-skill');
    assert.ok(alpha);
    assert.notEqual(alpha.installed, true);
  });

  it('hub unreachable → 502 on catalog and install', async () => {
    _setHubFetchForTests(fakeHubFetch({ failAll: true }));
    try {
      const list = await app.request('/api/skills/hub/skills');
      assert.equal(list.status, 502);
      const install = await app.request('/api/skills/hub/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'alpha-skill' }),
      });
      assert.equal(install.status, 502);
      const errBody = await json(install);
      assert.match(String((errBody['error'] as { message: string }).message), /SkillHub/);
    } finally {
      _setHubFetchForTests(fakeHubFetch());
    }
  });

  it('by-id routes still work alongside the hub routes (no route shadowing)', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '普通技能', description: 'd', instructions: '正文' }),
    });
    assert.equal(created.status, 201);
    const skill = ((await json(created))['skill'] as SkillManifestEntry);
    const one = await app.request(`/api/skills/${skill.id}`);
    assert.equal(one.status, 200);
    const del = await app.request(`/api/skills/${skill.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
  });
});
