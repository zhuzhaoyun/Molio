import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { skillsRoutes } from '../../src/routes/skills.js';
import { createSkill } from '../../src/core/skills/store.js';
import { openDatabase, closeDatabase, createVault, deleteVault } from '../../src/core/db.js';
import type { SkillManifestEntry } from '@molio/contracts';

/**
 * Skills route tests. The store resolves its base dirs from os.homedir(), so we
 * point HOME / USERPROFILE at a temp dir for this file (node --test runs each
 * file in its own process, so this doesn't leak to other suites). The routes
 * now take an isolated SQLite db (temp dir) so afterGlobalSkillMutation's
 * per-vault reconcile can be exercised without touching any real install.
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
  let db: Database.Database;
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-skills-routes-home-'));
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;

    db = openDatabase(join(home, 'dbdata'));

    const root = new Hono();
    root.route('/api/skills', skillsRoutes(db, fakeRunManager as never));
    app = root;
  });

  after(() => {
    closeDatabase();
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

  it('PATCH /:id/toggle flips the manifest enabled flag', async () => {
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tog', description: '', instructions: 'body' }),
    });
    const skill = (await json(created))['skill'] as SkillManifestEntry;

    const off = await app.request(`/api/skills/${skill.id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    assert.equal(((await json(off))['skill'] as SkillManifestEntry).enabled, false);

    const on = await app.request(`/api/skills/${skill.id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(((await json(on))['skill'] as SkillManifestEntry).enabled, true);
  });

  it('creating/toggling a skill propagates into an existing vault\'s .claude/skills', async () => {
    // Set up a real vault (temp dir) so afterGlobalSkillMutation has a target.
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-skills-routes-vault-'));
    const vault = createVault(db, 'V', vaultDir, '');
    try {

      // Create an enabled skill → reconcile fans it into the vault.
      const created = await app.request('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '传播', description: '', instructions: 'body' }),
      });
      const skill = (await json(created))['skill'] as SkillManifestEntry;
      const inVault = join(vaultDir, '.claude', 'skills', `molio--${skill.id}`, 'SKILL.md');
      assert.ok(existsSync(inVault), 'enabled skill should be synced into the vault');

      // Toggle it off → reconcile removes it from the vault.
      await app.request(`/api/skills/${skill.id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.ok(!existsSync(inVault), 'disabled skill should be removed from the vault');
    } finally {
      deleteVault(db, vault.id); // keep later tests vault-free
      rmSync(vaultDir, { recursive: true, force: true });
    }
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
      db,
      { id: 'builtin-x', name: '内置', description: '', enabled: false, builtIn: true },
      'body',
    );
    const del = await app.request(`/api/skills/${bi.id}`, { method: 'DELETE' });
    assert.equal(del.status, 400);
    const body = await json(del);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'BAD_REQUEST');
  });

  // ── bundled / core guards ──

  it('bundled skills are listed (kind=bundled) but not editable (PATCH 400), yet toggleable', async () => {
    const bundled = createSkill(
      db,
      { id: 'bundled-route-x', name: 'bundled', description: '', enabled: true, builtIn: true, kind: 'bundled' },
      '',
    );
    try {
      const list = (await json(await app.request('/api/skills')))['skills'] as SkillManifestEntry[];
      const found = list.find((s) => s.id === bundled.id);
      assert.ok(found, 'bundled skill should be listed');
      assert.equal(found!.kind, 'bundled');

      // Not editable.
      const patched = await app.request(`/api/skills/${bundled.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hacked' }),
      });
      assert.equal(patched.status, 400);

      // But toggleable.
      const off = await app.request(`/api/skills/${bundled.id}/toggle`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(off.status, 200);
      assert.equal(((await json(off))['skill'] as SkillManifestEntry).enabled, false);
    } finally {
      // Remove the row directly so it doesn't pollute later tests.
      db.prepare('DELETE FROM skills WHERE id = ?').run(bundled.id);
    }
  });

  it('core skills are hidden from GET and 404 on by-id routes', async () => {
    const core = createSkill(
      db,
      { id: 'core-route-x', name: 'core', description: '', enabled: true, builtIn: true, core: true },
      'core body',
    );
    try {
      const list = (await json(await app.request('/api/skills')))['skills'] as SkillManifestEntry[];
      assert.ok(!list.some((s) => s.id === core.id), 'core skill must not be listed');

      for (const [method, suffix, body] of [
        ['GET', '', undefined],
        ['PATCH', '', JSON.stringify({ name: 'x' })],
        ['PATCH', '/toggle', JSON.stringify({ enabled: false })],
      ] as const) {
        const res = await app.request(`/api/skills/${core.id}${suffix}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        assert.equal(res.status, 404, `${method} ${suffix} on core should be 404`);
      }

      const del = await app.request(`/api/skills/${core.id}`, { method: 'DELETE' });
      assert.equal(del.status, 404, 'DELETE on core should be 404');
    } finally {
      db.prepare('DELETE FROM skills WHERE id = ?').run(core.id);
    }
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
