import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { skillsRoutes } from '../../src/routes/skills.js';
import { createSkill, updateCustomInstructions } from '../../src/core/skills/store.js';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import { recordQuarantineEvent } from '../../src/core/skills/quarantine.js';

/**
 * Routes for the custom-instruction overlay (自定义指令) + quarantine ledger:
 * PATCH /:id/custom-instructions (ALL kinds — bundled's ONLY edit channel),
 * GET /:id serving bundled skills (relaxed from 404), and the /quarantine
 * event endpoints. Same HOME/db isolation strategy as skills.test.ts.
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const fakeRunManager = {
  createRun: () => Promise.reject(new Error('no agent installed')),
  onEvent: () => null,
  cancelRun: () => {},
};

describe('Skills custom-instructions routes', () => {
  let app: Hono;
  let db: Database.Database;
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'molio-skills-custom-home-'));
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

  it('PATCH /:id/custom-instructions works on a BUNDLED skill and GET /:id then serves it', async () => {
    const bundled = createSkill(
      db,
      { id: 'bundled-cx', name: 'bundled-cx', description: '', enabled: true, builtIn: true, kind: 'bundled' },
      '',
    );
    try {
      const res = await app.request(`/api/skills/${bundled.id}/custom-instructions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructions: '输出用简体中文\n带引用' }),
      });
      assert.equal(res.status, 200);
      const skill = (await json(res))['skill'] as { customInstructions?: string };
      assert.equal(skill.customInstructions, '输出用简体中文\n带引用');

      // GET /:id on bundled: 200 (was 404), overlay carried.
      const detail = await app.request(`/api/skills/${bundled.id}`);
      assert.equal(detail.status, 200, 'bundled GET /:id is relaxed to serve the editor');
      const body = (await json(detail)) as { skill: { customInstructions?: string }; instructions: string };
      assert.equal(body.skill.customInstructions, '输出用简体中文\n带引用');
      assert.equal(typeof body.instructions, 'string');
    } finally {
      db.prepare('DELETE FROM skills WHERE id = ?').run(bundled.id);
    }
  });

  it('PATCH works on library skills; empty string clears (absent field)', async () => {
    const s = createSkill(db, { name: '普通技能', description: '', enabled: true, builtIn: false }, '正文');
    const set = await app.request(`/api/skills/${s.id}/custom-instructions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: '临时' }),
    });
    assert.equal(set.status, 200);
    const clear = await app.request(`/api/skills/${s.id}/custom-instructions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: '' }),
    });
    assert.equal(clear.status, 200);
    const skill = (await json(clear))['skill'] as { customInstructions?: string };
    assert.equal(skill.customInstructions, undefined);
  });

  it('rejects >32KB bodies and non-string values; unknown id 404s', async () => {
    const s = createSkill(db, { name: '上限', description: '', enabled: true, builtIn: false }, '正文');
    const tooBig = await app.request(`/api/skills/${s.id}/custom-instructions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: 'x'.repeat(32769) }),
    });
    assert.equal(tooBig.status, 400);

    const notString = await app.request(`/api/skills/${s.id}/custom-instructions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: 42 }),
    });
    assert.equal(notString.status, 400);

    const missing = await app.request('/api/skills/no-such-id/custom-instructions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customInstructions: 'x' }),
    });
    assert.equal(missing.status, 404);
  });

  it('base PATCH /:id on bundled STILL 404s (overlay is the only bundled edit channel)', async () => {
    const bundled = createSkill(
      db,
      { id: 'bundled-locked', name: 'l', description: '', enabled: true, builtIn: true, kind: 'bundled' },
      '',
    );
    try {
      const res = await app.request(`/api/skills/${bundled.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      assert.equal(res.status, 404);
    } finally {
      db.prepare('DELETE FROM skills WHERE id = ?').run(bundled.id);
    }
  });

  it('GET /api/skills/quarantine is a real route (not eaten by /:id) and lists unacked events', async () => {
    // Route-order guard: if /quarantine were registered after /:id it would
    // 404 as an unknown skill id lookup.
    const empty = await app.request('/api/skills/quarantine');
    assert.equal(empty.status, 200);
    assert.deepEqual((await json(empty))['events'], []);

    const id = recordQuarantineEvent(db, {
      source: 'vault-drift',
      skillId: 'wiki-query',
      mirrorName: 'wiki-query',
      description: '测试事件',
      quarantinedPath: '/tmp/q',
    });
    const listed = await app.request('/api/skills/quarantine');
    const events = (await json(listed))['events'] as Array<{ id: number; source: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.source, 'vault-drift');

    const ack = await app.request(`/api/skills/quarantine/${id}/ack`, { method: 'POST' });
    assert.equal(ack.status, 204);
    const after = await app.request('/api/skills/quarantine');
    assert.deepEqual((await json(after))['events'], []);

    const reack = await app.request('/api/skills/quarantine/99999/ack', { method: 'POST' });
    assert.equal(reack.status, 404);
  });
});
