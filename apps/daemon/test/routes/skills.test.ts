import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { Hono } from 'hono';
import { skillsRoutes } from '../../src/routes/skills.js';
import { createSkill } from '../../src/core/skills/store.js';
import type { SkillManifestEntry } from '@molio/contracts';

/**
 * Skills route tests. The store resolves its base dirs from os.homedir(), so we
 * point HOME / USERPROFILE at a temp dir for this file (node --test runs each
 * file in its own process, so this doesn't leak to other suites).
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// Fake RunManager: createRun rejects so /prefill exercises its graceful fallback
// path without needing a real Claude binary.
const fakeRunManager = {
  createRun: () => Promise.reject(new Error('no agent installed')),
  onEvent: () => null,
  cancelRun: () => {},
};

describe('Skills routes', () => {
  let app: Hono;
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-skills-routes-home-'));
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;

    const root = new Hono();
    root.route('/api/skills', skillsRoutes(fakeRunManager as never));
    app = root;
  });

  after(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = savedUserProfile;
    rmSync(home, { recursive: true, force: true });
  });

  it('GET / starts empty', async () => {
    const res = await app.request('/api/skills');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body['skills'], []);
  });

  it('POST / creates a skill (enabled, non-built-in)', async () => {
    const res = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '写文章', description: '写一篇文章', instructions: '先列大纲。' }),
    });
    assert.equal(res.status, 201);
    const body = await json(res);
    const skill = body['skill'] as SkillManifestEntry;
    assert.equal(skill.name, '写文章');
    assert.equal(skill.builtIn, false);
    assert.equal(skill.enabled, true);
    assert.ok(skill.id);
  });

  it('GET /:id returns the skill with its instructions; unknown → 404', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '可读', description: 'd', instructions: '指令正文' }),
    });
    const skill = (await json(created))['skill'] as SkillManifestEntry;

    const one = await app.request(`/api/skills/${skill.id}`);
    assert.equal(one.status, 200);
    const body = await json(one);
    assert.equal((body['skill'] as SkillManifestEntry).name, '可读');
    assert.equal(body['instructions'], '指令正文');

    const missing = await app.request('/api/skills/nope');
    assert.equal(missing.status, 404);
  });

  it('POST / rejects missing name/instructions', async () => {
    const res = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', description: '', instructions: '' }),
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /:id updates name; PATCH unknown → 404', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Old', description: '', instructions: 'body' }),
    });
    const skill = (await json(created))['skill'] as SkillManifestEntry;

    const patched = await app.request(`/api/skills/${skill.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(((await json(patched))['skill'] as SkillManifestEntry).name, 'New');

    const missing = await app.request('/api/skills/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(missing.status, 404);
  });

  it('PATCH /:id/toggle flips enabled and removes/re-adds the sync dir', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tog', description: '', instructions: 'body' }),
    });
    const skill = (await json(created))['skill'] as SkillManifestEntry;
    const syncDir = join(home, '.claude', 'skills', `molio--${skill.id}`);
    assert.ok(existsSync(syncDir), 'enabled on create → synced');

    const off = await app.request(`/api/skills/${skill.id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    assert.equal(((await json(off))['skill'] as SkillManifestEntry).enabled, false);
    assert.ok(!existsSync(syncDir), 'disabled → sync dir removed');
  });

  it('DELETE /:id removes a user skill (204)', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Del', description: '', instructions: 'body' }),
    });
    const skill = (await json(created))['skill'] as SkillManifestEntry;
    const del = await app.request(`/api/skills/${skill.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    const list = (await json(await app.request('/api/skills')))['skills'] as SkillManifestEntry[];
    assert.ok(!list.some((s) => s.id === skill.id));
  });

  it('DELETE on a built-in skill → 400', async () => {
    // Seed a built-in directly via the store (uses the temp home).
    const bi = createSkill(
      { id: 'builtin-x', name: '内置', description: '', enabled: false, builtIn: true },
      'body',
    );
    const del = await app.request(`/api/skills/${bi.id}`, { method: 'DELETE' });
    assert.equal(del.status, 400);
    const body = await json(del);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'BAD_REQUEST');
  });

  it('POST /import from raw SKILL.md text', async () => {
    const raw = '---\nname: 导入的\ndescription: d\n---\n\n指令正文';
    const res = await app.request('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    assert.equal(res.status, 201);
    const skill = (await json(res))['skill'] as SkillManifestEntry;
    assert.equal(skill.name, '导入的');
  });

  it('POST /import rejects when both/neither raw and folderPath given', async () => {
    const neither = await app.request('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(neither.status, 400);

    const both = await app.request('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: 'x', folderPath: 'y' }),
    });
    assert.equal(both.status, 400);
  });

  it('POST /prefill with empty content → 400', async () => {
    const res = await app.request('/api/skills/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '  ' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /prefill falls back gracefully when the agent is unavailable', async () => {
    const res = await app.request('/api/skills/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '一段助手回复' }),
    });
    assert.equal(res.status, 200);
    const prefill = (await json(res))['prefill'] as Record<string, unknown>;
    assert.equal(prefill['fallback'], true);
    assert.equal(prefill['instructions'], '一段助手回复');
  });
});
