import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { createSkill } from '../../src/core/skills/store.js';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import type { VaultSkillEntry } from '@molio/contracts';

/**
 * Per-vault skills route tests (GET/PATCH /api/knowledge/vaults/:id/skills).
 * HOME/USERPROFILE point at a temp dir so the skill library + the route's
 * default-home reconcile live in isolation; the db is a temp-dir SQLite file.
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// The vault-skills routes touch neither runManager nor vaultWatcher.
const fakeRunManager = {} as never;
const fakeVaultWatcher = { watch: () => {}, unwatch: () => {}, on: () => {}, off: () => {} } as never;

describe('Knowledge per-vault skills routes', () => {
  let app: Hono;
  let db: Database.Database;
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-kvs-home-'));
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;

    db = openDatabase(join(home, 'dbdata'));

    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, fakeRunManager, fakeVaultWatcher));
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

  /** Create a vault through the API (also installs builtin skills + reconciles). */
  async function createVaultViaApi(vaultDir: string): Promise<string> {
    const res = await app.request('/api/knowledge/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'V', path: vaultDir }),
    });
    assert.equal(res.status, 201);
    const body = await json(res);
    return body['id'] as string;
  }

  it('GET /vaults/:id/skills on unknown vault → 404', async () => {
    const res = await app.request('/api/knowledge/vaults/nope/skills');
    assert.equal(res.status, 404);
  });

  it('lists library skills with computed global/vault state', async () => {
    const skill = createSkill(
      db,
      { name: '列表', description: 'd', enabled: true, builtIn: false },
      'body',
    );
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-kvs-vault-'));
    try {
      const vaultId = await createVaultViaApi(vaultDir);
      const res = await app.request(`/api/knowledge/vaults/${vaultId}/skills`);
      assert.equal(res.status, 200);
      const skills = (await json(res))['skills'] as VaultSkillEntry[];
      const entry = skills.find((s) => s.id === skill.id);
      assert.ok(entry, 'created skill listed');
      assert.equal(entry!.globalEnabled, true);
      assert.equal(entry!.vaultEnabled, true, 'inherits global-on by default');
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('POST /vaults reconciles enabled skills into the new vault, PATCH opts out', async () => {
    const skill = createSkill(
      db,
      { name: '传播', description: '', enabled: true, builtIn: false },
      'body',
    );
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-kvs-vault-'));
    try {
      const vaultId = await createVaultViaApi(vaultDir);
      const synced = join(vaultDir, '.claude', 'skills', `molio--${skill.id}`, 'SKILL.md');
      assert.ok(existsSync(synced), 'enabled skill synced on vault creation');

      // Opt out of this vault.
      const patch = await app.request(`/api/knowledge/vaults/${vaultId}/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(patch.status, 200);
      const updated = (await json(patch))['skill'] as VaultSkillEntry;
      assert.equal(updated.vaultEnabled, false);
      assert.equal(updated.globalEnabled, true, 'global master switch unchanged');
      assert.ok(!existsSync(synced), 'opt-out removed the skill from the vault');

      // GET reflects the override.
      const list = (await json(await app.request(`/api/knowledge/vaults/${vaultId}/skills`)))[
        'skills'
      ] as VaultSkillEntry[];
      assert.equal(list.find((s) => s.id === skill.id)?.vaultEnabled, false);
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('PATCH unknown vault → 404; unknown skill → 404; non-boolean enabled → 400', async () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-kvs-vault-'));
    try {
      const vaultId = await createVaultViaApi(vaultDir);

      const noVault = await app.request('/api/knowledge/vaults/nope/skills/x', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(noVault.status, 404);

      const noSkill = await app.request(`/api/knowledge/vaults/${vaultId}/skills/does-not-exist`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(noSkill.status, 404);

      // A real skill to pass the 404 check, then send a bad body.
      const skill = createSkill(db, { name: 'Bad', description: '', enabled: true, builtIn: false }, 'body');
      const badBody = await app.request(`/api/knowledge/vaults/${vaultId}/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      assert.equal(badBody.status, 400);
    } finally {
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('core skills are hidden from the per-vault list and PATCH → 404', async () => {
    const core = createSkill(
      db,
      { name: '写文章', description: '', enabled: true, builtIn: true, core: true },
      'core body',
    );
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-kvs-vault-'));
    try {
      const vaultId = await createVaultViaApi(vaultDir);

      const list = (await json(await app.request(`/api/knowledge/vaults/${vaultId}/skills`)))[
        'skills'
      ] as VaultSkillEntry[];
      assert.ok(!list.some((s) => s.id === core.id), 'core skill must not be listed per-vault');

      const patch = await app.request(`/api/knowledge/vaults/${vaultId}/skills/${core.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      assert.equal(patch.status, 404, 'core skill cannot be opted out per-vault');
    } finally {
      db.prepare('DELETE FROM skills WHERE id = ?').run(core.id);
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('bundled skills appear with kind=bundled in the per-vault list', async () => {
    const bundled = createSkill(
      db,
      { name: 'docling', description: '', enabled: true, builtIn: true, kind: 'bundled' },
      '',
    );
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-kvs-vault-'));
    try {
      const vaultId = await createVaultViaApi(vaultDir);
      const list = (await json(await app.request(`/api/knowledge/vaults/${vaultId}/skills`)))[
        'skills'
      ] as VaultSkillEntry[];
      const entry = list.find((s) => s.id === bundled.id);
      assert.ok(entry, 'bundled skill listed per-vault');
      assert.equal(entry!.kind, 'bundled');
    } finally {
      db.prepare('DELETE FROM skills WHERE id = ?').run(bundled.id);
      rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});
