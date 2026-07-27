/**
 * Skills API routes — the user-managed global skill library.
 * Source of truth: ~/.molio/skills/ ; enabled skills sync to ~/.claude/skills/molio--*.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillRequest,
  PrefillRequest,
} from '@molio/contracts';
import type { RunManager } from '../core/RunManager.js';
import {
  loadManifest,
  getSkill,
  readInstructions,
  createSkill,
  updateSkill,
  toggleSkill,
  deleteSkill,
  SkillNotFoundError,
} from '../core/skills/store.js';
import { importFromRaw, importFromFolder, SkillImportError } from '../core/skills/importer.js';
import { prefillFromContent } from '../core/skills/prefill.js';

export function skillsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  // GET /api/skills — list all skills
  app.get('/', (c) => {
    return c.json({ skills: loadManifest().skills });
  });

  // GET /api/skills/:id — one skill + its instructions (for the edit form)
  app.get('/:id', (c) => {
    const skill = getSkill(c.req.param('id'));
    if (!skill) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    return c.json({ skill, instructions: readInstructions(skill.id) });
  });

  // POST /api/skills — create a user skill (enabled by default)
  app.post('/', async (c) => {
    const body = await c.req.json<CreateSkillRequest>();
    if (!body.name || !body.name.trim() || !body.instructions || !body.instructions.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'name and instructions are required' } }, 400);
    }
    try {
      const skill = createSkill(
        { name: body.name.trim(), description: (body.description ?? '').trim(), enabled: true, builtIn: false },
        body.instructions,
      );
      return c.json({ skill }, 201);
    } catch (err) {
      return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
    }
  });

  // PATCH /api/skills/:id — update name/description/instructions (built-ins editable too)
  app.patch('/:id', async (c) => {
    const body = await c.req.json<UpdateSkillRequest>();
    try {
      const skill = updateSkill(c.req.param('id'), body);
      return c.json({ skill });
    } catch (err) {
      return mapStoreError(c, err);
    }
  });

  // PATCH /api/skills/:id/toggle — enable/disable
  app.patch('/:id/toggle', async (c) => {
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'enabled must be a boolean' } }, 400);
    }
    try {
      const skill = toggleSkill(c.req.param('id'), body.enabled);
      return c.json({ skill });
    } catch (err) {
      return mapStoreError(c, err);
    }
  });

  // DELETE /api/skills/:id — delete (built-ins cannot be deleted, only disabled)
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    const existing = getSkill(id);
    if (!existing) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    if (existing.builtIn) {
      return c.json({ error: { code: 'BAD_REQUEST', message: '内置技能不可删除，可禁用' } }, 400);
    }
    deleteSkill(id);
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
      const skill = hasRaw ? importFromRaw(body.raw!) : importFromFolder(body.folderPath!);
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
