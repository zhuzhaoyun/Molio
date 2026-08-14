/**
 * Skills API routes — the user-managed skill library (global master switch).
 * Source of truth: the daemon's `skills` table. After any mutation we re-sync
 * every vault's `<vault>/.claude/skills/` via afterGlobalSkillMutation
 * (vault-config.ts).
 *
 * Visibility/guards:
 *  - core skills (writing trio) and bundled skills (shipped with the app) are
 *    app-owned functionality: hidden from the list, 404 on every by-id route,
 *    and always effective regardless of the `enabled` flag (vault-config.ts).
 *    They are wired into deterministic app paths (KB panel wiki actions,
 *    channel intent routing, docling preload), so letting users toggle them
 *    would silently break UI that still shows the feature entry points.
 *  - builtIn rows that somehow aren't core/bundled still can't be deleted;
 *  - library (user-created/imported) skills get full CRUD + toggle.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import type {
  CreateSkillRequest,
  UpdateSkillRequest,
  ImportSkillRequest,
  PrefillRequest,
  InstallHubSkillRequest,
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
import { afterGlobalSkillMutation } from '../core/skills/vault-config.js';
import { importFromRaw, importFromFolder, SkillImportError } from '../core/skills/importer.js';
import { prefillFromContent } from '../core/skills/prefill.js';
import {
  fetchHubSkills,
  fetchHubCategories,
  fetchHubSkillDetail,
  installHubSkill,
  listHubInstalls,
  hubInstallKey,
  removeHubInstallBySkillId,
  HubError,
} from '../core/skills/hub.js';

/**
 * Parse the request body as a JSON object. Returns null for malformed JSON,
 * a missing/empty body, or valid JSON that is NOT an object (`null`, `[1]`,
 * `"str"`) — all of which would otherwise throw inside the handler and surface
 * as an opaque 500 (or a TypeError on `body.x`) instead of a clean 400.
 */
async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function skillsRoutes(db: Database.Database, runManager: RunManager): Hono {
  const app = new Hono();

  // GET /api/skills — list user-managed skills only (core + bundled are hidden
  // app functionality, always effective and not configurable).
  app.get('/', (c) => {
    return c.json({ skills: listSkills(db).filter((s) => !s.core && s.kind !== 'bundled') });
  });

  // ─── Skill hub (skillhub.cn marketplace, proxied by the daemon) ───
  // Registered BEFORE the by-id routes: /hub/* are catalog operations, never a
  // skill id lookup.

  // GET /api/skills/hub/skills — browse/search the hub catalog, annotated with
  // the local install state (installed / installedVersion) from hub_skill_installs.
  app.get('/hub/skills', async (c) => {
    try {
      const q = c.req.query();
      const page = Number(q['page']);
      const pageSize = Number(q['pageSize']);
      const result = await fetchHubSkills({
        page: Number.isFinite(page) && page > 0 ? Math.floor(page) : undefined,
        pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : undefined,
        keyword: q['keyword'],
        category: q['category'],
        // Unknown values fall back to the hub's default ranking in fetchHubSkills.
        sort: q['sort'] as 'default' | 'downloads' | 'updated' | undefined,
      });
      // Keyed by (namespace, slug) — same slug in different namespaces are
      // separate installs (hubInstallKey normalizes a missing namespace to '').
      const installs = new Map(listHubInstalls(db).map((r) => [hubInstallKey(r.slug, r.namespace), r]));
      const skills = result.skills.map((s) => {
        const rec = installs.get(hubInstallKey(s.slug, s.namespace));
        // An install record whose skill row vanished (manual DB edits) is stale:
        // don't claim "installed" for it — the next install re-creates cleanly.
        if (!rec || !getSkill(db, rec.skill_id)) return s;
        return { ...s, installed: true, installedVersion: rec.version };
      });
      return c.json({ skills, total: result.total, page: result.page, pageSize: result.pageSize });
    } catch (err) {
      return mapHubError(c, err);
    }
  });

  // GET /api/skills/hub/skill — one hub skill's detail (store detail modal):
  // upstream detail + SKILL.md body, annotated with the local install state.
  // Registered BEFORE the by-id routes: a catalog lookup, never a local id.
  app.get('/hub/skill', async (c) => {
    const slug = c.req.query('slug')?.trim();
    if (!slug) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'slug is required' } }, 400);
    }
    const namespace = c.req.query('namespace')?.trim() || undefined;
    try {
      const detail = await fetchHubSkillDetail(slug, namespace);
      // Same installed annotation as /hub/skills (incl. the stale-record check).
      const rec = listHubInstalls(db).find(
        (r) => hubInstallKey(r.slug, r.namespace) === hubInstallKey(slug, namespace ?? ''),
      );
      if (rec && getSkill(db, rec.skill_id)) {
        detail.installed = true;
        detail.installedVersion = rec.version;
      }
      return c.json({ detail });
    } catch (err) {
      return mapHubError(c, err);
    }
  });

  // GET /api/skills/hub/categories — hub category list for the store filter.
  app.get('/hub/categories', async (c) => {
    try {
      const categories = await fetchHubCategories();
      return c.json({ categories });
    } catch (err) {
      return mapHubError(c, err);
    }
  });

  // POST /api/skills/hub/install — download a hub skill and import it into the
  // library (or refresh it in place when the (namespace, slug) pair is already
  // installed), then fan out to every vault like any other skill mutation.
  app.post('/hub/install', async (c) => {
    const body = (await readJsonObject(c)) as InstallHubSkillRequest | null;
    if (!body || typeof body.slug !== 'string' || !body.slug.trim()) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'slug is required' } }, 400);
    }
    try {
      const result = await installHubSkill(db, {
        slug: body.slug,
        version: typeof body.version === 'string' ? body.version : undefined,
        namespace: typeof body.namespace === 'string' ? body.namespace : undefined,
      });
      await afterGlobalSkillMutation(db);
      return c.json({ skill: result.skill, updated: result.updated, version: result.version }, 201);
    } catch (err) {
      if (err instanceof SkillImportError) {
        const status = err.code === 'NOT_FOUND' ? 404 : 400;
        return c.json({ error: { code: err.code, message: err.message } }, status);
      }
      return mapHubError(c, err);
    }
  });

  // GET /api/skills/:id — one skill + its instructions (for the edit/duplicate
  // form). Core and bundled skills are treated as not found (hidden app
  // functionality, never shown/editable).
  app.get('/:id', (c) => {
    const skill = getSkill(db, c.req.param('id'));
    if (!skill || skill.core || skill.kind === 'bundled') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    return c.json({ skill, instructions: readInstructions(skill.id) });
  });

  // POST /api/skills — create a user (library) skill, enabled by default
  app.post('/', async (c) => {
    const body = (await readJsonObject(c)) as CreateSkillRequest | null;
    // typeof guards: a non-string field (e.g. {"name": 123}) passes plain
    // truthiness and then throws on .trim() — OUTSIDE the try/catch — which
    // surfaced as an opaque 500 instead of a 400.
    if (
      !body ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      typeof body.instructions !== 'string' ||
      !body.instructions.trim()
    ) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'name and instructions are required' } }, 400);
    }
    if (body.description != null && typeof body.description !== 'string') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'description must be a string' } }, 400);
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
  // bundled (content ships with the app) and core are hidden → 404.
  app.patch('/:id', async (c) => {
    const existing = getSkill(db, c.req.param('id'));
    if (!existing || existing.core || existing.kind === 'bundled') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    const body = (await readJsonObject(c)) as UpdateSkillRequest | null;
    if (!body) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'request body must be a JSON object' } }, 400);
    }
    // Same typeof contract as POST: non-string fields flow into updateSkill →
    // generateSkillMd and throw deep in the write path instead of 400ing here.
    if (
      (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) ||
      (body.description !== undefined && typeof body.description !== 'string') ||
      (body.instructions !== undefined && typeof body.instructions !== 'string')
    ) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'name/description/instructions must be strings' } },
        400,
      );
    }
    try {
      const skill = updateSkill(db, c.req.param('id'), body);
      await afterGlobalSkillMutation(db);
      return c.json({ skill });
    } catch (err) {
      return mapStoreError(c, err);
    }
  });

  // PATCH /api/skills/:id/toggle — enable/disable library skills. core and
  // bundled are always effective (hidden → 404, the `enabled` flag is ignored).
  app.patch('/:id/toggle', async (c) => {
    const existing = getSkill(db, c.req.param('id'));
    if (!existing || existing.core || existing.kind === 'bundled') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    const body = (await readJsonObject(c)) as { enabled: boolean } | null;
    if (!body || typeof body.enabled !== 'boolean') {
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

  // DELETE /api/skills/:id — delete (core/bundled hidden → 404; other builtIn
  // rows are app-owned and cannot be deleted).
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getSkill(db, id);
    if (!existing || existing.core || existing.kind === 'bundled') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Skill not found' } }, 404);
    }
    if (existing.builtIn) {
      return c.json({ error: { code: 'BAD_REQUEST', message: '内置技能不可删除' } }, 400);
    }
    deleteSkill(db, id);
    // Drop the hub mapping too, so the store shows this slug as installable again.
    removeHubInstallBySkillId(db, id);
    await afterGlobalSkillMutation(db);
    return c.body(null, 204);
  });

  // POST /api/skills/import — import from pasted SKILL.md raw text OR a local folder path
  app.post('/import', async (c) => {
    const body = (await readJsonObject(c)) as ImportSkillRequest | null;
    const hasRaw = !!body && typeof body.raw === 'string' && body.raw.trim().length > 0;
    const hasFolder = !!body && typeof body.folderPath === 'string' && body.folderPath.trim().length > 0;
    if (hasRaw === hasFolder) {
      return c.json(
        { error: { code: 'BAD_REQUEST', message: 'provide exactly one of: raw, folderPath' } },
        400,
      );
    }
    try {
      // body! is safe: a null body makes hasRaw === hasFolder (both false)
      // and the guard above already returned 400.
      const skill = hasRaw ? importFromRaw(db, body.raw!) : importFromFolder(db, body!.folderPath!);
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
    const body = (await readJsonObject(c)) as PrefillRequest | null;
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
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

/**
 * Map hub-layer errors to HTTP: unreachable hub / bad envelope → 502 (the UI
 * shows the message verbatim), unknown slug → 404, invalid input/package → 400.
 */
function mapHubError(c: Context, err: unknown) {
  if (err instanceof HubError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return c.json({ error: { code: err.code, message: err.message } }, 404);
      case 'BAD_REQUEST':
        return c.json({ error: { code: err.code, message: err.message } }, 400);
      case 'HUB_UNAVAILABLE':
        return c.json({ error: { code: err.code, message: err.message } }, 502);
    }
  }
  return c.json({ error: { code: 'INTERNAL', message: errMessage(err) } }, 500);
}
