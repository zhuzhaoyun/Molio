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
 * Fake hub: catalog list + categories + zip download + skill detail/readme.
 * `failAll` flips every request into a network error to exercise the 502 mapping.
 */
function fakeHubFetch(opts: { failAll?: boolean } = {}): typeof fetch {
  return (async (input: unknown) => {
    if (opts.failAll) throw new Error('ECONNREFUSED (fake)');
    const url = String(input);
    // Checked BEFORE the detail branch: the readme URL also matches /api/v1/skills/.
    if (url.includes('/file?path=SKILL.md')) {
      return new Response('---\nname: 商店技能\nversion: 1.0.0\n---\n\n商店技能详情正文', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (url.includes('/api/v1/skills/')) {
      const slug = /\/api\/v1\/skills\/([\w.-]+)/.exec(url)?.[1];
      if (slug === 'alpha-skill' || slug === 'beta-skill') {
        return new Response(
          JSON.stringify({
            slug,
            skill: {
              slug,
              displayName: slug === 'alpha-skill' ? 'Alpha 详情' : 'Beta 详情',
              summary: 'english summary',
              summary_zh: slug === 'alpha-skill' ? '阿尔法详情' : '贝塔详情',
              category: 'office-efficiency',
              createdAt: 1785000000000,
              updatedAt: 1786000000000,
              labels: { requires_api_key: 'false' },
              stats: { downloads: 10, installs: 2, stars: 1, versions: 1 },
            },
            latestVersion: { version: '1.0.0', changelog: 'init' },
            owner: { handle: slug === 'alpha-skill' ? 'alice' : 'bob', displayName: 'Owner' },
            namespace: { handle: slug === 'alpha-skill' ? 'alice' : 'bob' },
            securityReports: { keen: { status: 'benign', statusText: '安全，无风险' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('missing', { status: 404 });
    }
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
              {
                slug: 'beta-skill',
                name: 'Beta',
                description: 'beta skill',
                namespace: { handle: 'bob' },
              },
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
      const slugMatch = /slug=([\w.-]+)/.exec(url);
      const slug = slugMatch?.[1];
      if (slug !== 'alpha-skill' && slug !== 'beta-skill') {
        return new Response('missing', { status: 404 });
      }
      const zip = zipOf({
        'SKILL.md': SKILL_MD('商店技能正文', '1.0.0'),
        '_meta.json': JSON.stringify({ slug, version: '1.0.0' }),
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

  it('install registry keys on (namespace, slug): same slug coexists across namespaces', async () => {
    // beta's catalog entry carries namespace 'bob'; install it under bob…
    const r1 = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'beta-skill', namespace: 'bob' }),
    });
    assert.equal(r1.status, 201);
    const b1 = (await json(r1)) as unknown as InstallHubSkillResponse;
    assert.equal(b1.updated, false);

    // …and under a second namespace: same slug, but a separate skill row
    // (a slug-only registry would have silently refreshed bob's install).
    const r2 = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'beta-skill', namespace: 'carol' }),
    });
    assert.equal(r2.status, 201);
    const b2 = (await json(r2)) as unknown as InstallHubSkillResponse;
    assert.equal(b2.updated, false);
    assert.notEqual(b1.skill.id, b2.skill.id);

    // A namespaced install of alpha must NOT annotate the namespace-less
    // catalog entry — the annotation key is (namespace, slug) too.
    const r3 = await app.request('/api/skills/hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'alpha-skill', namespace: 'alice' }),
    });
    assert.equal(r3.status, 201);

    const hub = (await json(await app.request('/api/skills/hub/skills'))) as unknown as HubSkillsListResponse;
    const beta = hub.skills.find((s) => s.slug === 'beta-skill');
    assert.ok(beta);
    assert.equal(beta.installed, true); // bob's record matches the catalog entry's namespace
    const alpha = hub.skills.find((s) => s.slug === 'alpha-skill');
    assert.ok(alpha);
    assert.notEqual(alpha.installed, true);
  });

  it('GET /hub/skill returns detail with readme and the installed annotation', async () => {
    // From the previous tests: alpha is installed ONLY under namespace
    // 'alice'; beta under 'bob' + 'carol'. The annotation must follow the
    // REQUESTED namespace, not the detail response's own namespace field.
    const alpha = await app.request('/api/skills/hub/skill?slug=alpha-skill');
    assert.equal(alpha.status, 200);
    const aBody = ((await json(alpha))['detail'] as Record<string, unknown>);
    assert.equal(aBody['name'], 'Alpha 详情');
    assert.equal(aBody['description'], '阿尔法详情'); // zh-first
    assert.equal(aBody['readme'], '商店技能详情正文'); // frontmatter stripped
    assert.equal(aBody['installed'], undefined); // no namespace-less install exists
    assert.equal(aBody['latestVersion'], '1.0.0');
    assert.deepEqual(aBody['security'], { keen: '安全，无风险' });

    const bob = await app.request('/api/skills/hub/skill?slug=beta-skill&namespace=bob');
    assert.equal(bob.status, 200);
    const bBody = ((await json(bob))['detail'] as Record<string, unknown>);
    assert.equal(bBody['installed'], true);
    assert.equal(bBody['installedVersion'], '1.0.0');

    // carol's record of the same slug is a separate install — its annotation
    // must not leak into bob's view and vice versa.
    const carol = await app.request('/api/skills/hub/skill?slug=beta-skill&namespace=carol');
    assert.equal(carol.status, 200);
    assert.equal(((await json(carol))['detail'] as Record<string, unknown>)['installed'], true);
  });

  it('GET /hub/skill validates input and maps upstream errors', async () => {
    assert.equal((await app.request('/api/skills/hub/skill')).status, 400);
    assert.equal((await app.request('/api/skills/hub/skill?slug=ghost-skill')).status, 404);
  });

  it('GET /hub/skills forwards the sort param upstream', async () => {
    const urls: string[] = [];
    _setHubFetchForTests((async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ code: 0, data: { skills: [], total: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch);
    try {
      const res = await app.request('/api/skills/hub/skills?sort=downloads');
      assert.equal(res.status, 200);
      assert.ok(urls.some((u) => u.includes('sortBy=downloads') && u.includes('order=desc')), urls.join('\n'));
    } finally {
      _setHubFetchForTests(fakeHubFetch());
    }
  });

  it('hub unreachable → 502 on catalog, install and detail', async () => {
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
      const detail = await app.request('/api/skills/hub/skill?slug=alpha-skill');
      assert.equal(detail.status, 502);
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
