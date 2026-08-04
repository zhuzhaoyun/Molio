/**
 * Skills API routes — the user-managed skill library (global master switch).
 * Source of truth: the daemon's `skills` table. After any mutation we re-sync
 * every vault's `<vault>/.claude/skills/` via afterGlobalSkillMutation
 * (vault-config.ts).
 *
 * Visibility/guards:
 *  - core skills (writing trio) are never exposed (filtered from GET, 404 by id);
 *  - bundled skills are shown + toggleable but NOT editable (PATCH 400);
 *  - builtIn/core skills cannot be deleted.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import type {
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillRequest,
  PrefillRequest,
} from '@molio/contracts';
import type { RunManager } from '../core/RunManager.js';
import {
  listSkills,
  getSkill,
  readInstructions,
  createSkill,
  updateSkill,
  toggleSkill,
  deleteSkill,
  SkillNotFoundError,
} from '../core/skills/store.js';
import { afterGlobalSkillMutation, deleteVaultSkillOverrides } from '../core/skills/vault-config.js';
import { importFromRaw, importFromFolder, SkillImportError } from '../core/skills/importer.js';
import { prefillFromContent } from '../core/skills/prefill.js';
import { readBundledInstructions } from '../core/skills/builtin.js';

export function skillsRoutes(db: Database.Database, runManager: RunManager): Hono {
  const app = new Hono();

  // GET /api/skills — list all non-core skills (core = hidden app functionality)
  app.get('/', (c) => {
    return c.json({ skills: listSkills(db).filter((s) => !s.core) });
  });

  // GET /api/skills/:id — one skill + its instructions (for the edit/duplicate
  // form). Core skills are treated as not found (they're never shown/editable).
  // Bundled skills have no library content dir, so their body is read from the
  // shipped SKILL.md (lets "duplicate" prefill a real copy).
  app.get('/:id', (c) => {
    const skill = getSkill(db, c.req.param('id'));
    if (!skill || skill.core) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    const instructions =
      skill.kind === 'bundled' ? readBundledInstructions(skill.id) : readInstructions(skill.id);
    return c.json({ skill, instructions });
  });

  // POST /api/skills — create a user (library) skill, enabled by default
  app.post('/', async (c) => {
    const body = await c.req.json<CreateSkillRequest>();
    if (!body.name || !body.name.trim() || !body.instructions || !body.instructions.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'name and instructions are required' } }, 400);
    }
    try {
      const skill = createSkill(
        db,
        { name: body.name.trim(), description: (body.description ?? '').trim(), enabled: true, builtIn: false },
        body.instructions,
      );
      await afterGlobalSkillMutation(db);
      return c.json({ skill }, 201);
    } catch (err) {
      return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
    }
  });

  // PATCH /api/skills/:id — update name/description/instructions.
  // bundled (content ships with the app) and core are not editable.
  app.patch('/:id', async (c) => {
    const existing = getSkill(db, c.req.param('id'));
    if (!existing || existing.core) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    if (existing.kind === 'bundled') {
      return c.json({ error: { code: 'BAD_REQUEST', message: '内置技能不可编辑' } }, 400);
    }
    const body = await c.req.json<UpdateSkillRequest>();
    try {
      const skill = updateSkill(db, c.req.param('id'), body);
      await afterGlobalSkillMutation(db);
      return c.json({ skill });
    } catch (err) {
      return mapStoreError(c, err);
    }
  });

  // PATCH /api/skills/:id/toggle — enable/disable (bundled allowed, core blocked)
  app.patch('/:id/toggle', async (c) => {
    const existing = getSkill(db, c.req.param('id'));
    if (!existing || existing.core) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'enabled must be a boolean' } }, 400);
    }
    try {
      const skill = toggleSkill(db, c.req.param('id'), body.enabled);
      await afterGlobalSkillMutation(db);
      return c.json({ skill });
    } catch (err) {
      return mapStoreError(c, err);
    }
  });

  // DELETE /api/skills/:id — delete (builtIn/core cannot be deleted, only disabled)
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getSkill(db, id);
    if (!existing || existing.core) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    if (existing.builtIn) {
      return c.json({ error: { code: 'BAD_REQUEST', message: '内置技能不可删除，可禁用' } }, 400);
    }
    deleteSkill(db, id);
    deleteVaultSkillOverrides(db, id);
    await afterGlobalSkillMutation(db);
    return c.body(null, 204);
  });

  // POST /api/skills/import — import from pasted SKILL.md raw text OR a local folder path
  app.post('/import', async (c) => {
    const body = await c.req.json<ImportSkillRequest>();
    const hasRaw = typeof body.raw === 'string' && body.raw.trim().length > 0;
    const hasFolder = typeof body.folderPath === 'string' && body.folderPath.trim().length > 0;
    if (hasRaw === hasFolder) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'provide exactly one of: raw, folderPath' } },
        400,
      );
    }
    try {
      const skill = hasRaw ? importFromRaw(db, body.raw!) : importFromFolder(db, body.folderPath!);
      await afterGlobalSkillMutation(db);
      return c.json({ skill }, 201);
    } catch (err) {
      if (err instanceof SkillImportError) {
        const status = err.code === 'NOT_FOUND' ? 404 : 400;
        return c.json({ error: { code: err.code, message: err.message } }, status);
      }
      return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
    }
  });

  // POST /api/skills/prefill — run a one-shot Claude call to prefill a skill form.
  // Always resolves (fallback result on any failure) so the UI can show an editable form.
  app.post('/prefill', async (c) => {
    const body = await c.req.json<PrefillRequest>();
    if (!body.content || !body.content.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'content is required' } }, 400);
    }
    const prefill = await prefillFromContent(body.content, runManager);
    return c.json({ prefill });
  });

  return app;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error';
}

/** Map store-layer errors (currently just SkillNotFoundError) to HTTP responses. */
function mapStoreError(c: Context, err: unknown) {
  if (err instanceof SkillNotFoundError) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
  }
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}
