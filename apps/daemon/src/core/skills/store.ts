/**
 * Skill library store — manifest CRUD + SKILL.md materialization.
 *
 * The manifest (`~/.molio/skills/manifest.json`) is the source of truth for
 * metadata + enabled state; each skill's instructions live in
 * `~/.molio/skills/<id>/SKILL.md`. Mutations keep the `~/.claude/skills/molio--*`
 * sync in sync (see sync.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SkillManifestEntry } from '@molio/contracts';
import { manifestPath, skillContentDir, type SkillPathsOpts } from './paths.js';
import { generateSkillMd, stripFrontmatter } from './skillmd.js';
import { syncSkill, removeSkillSyncDir, reconcileSync } from './sync.js';

export interface SkillManifest {
  skills: SkillManifestEntry[];
}

export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`Skill not found: ${id}`);
    this.name = 'SkillNotFoundError';
  }
}

export function loadManifest(opts?: SkillPathsOpts): SkillManifest {
  try {
    const file = manifestPath(opts);
    if (!fs.existsSync(file)) return { skills: [] };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.skills)) return { skills: [] };
    return { skills: parsed.skills };
  } catch (err) {
    console.error('[skills] Failed to load manifest:', err instanceof Error ? err.message : err);
    return { skills: [] };
  }
}

/** Atomic write: mkdir -p + write to .tmp + rename (mirrors config.ts saveConfig). */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

export function saveManifest(manifest: SkillManifest, opts?: SkillPathsOpts): void {
  writeJsonAtomic(manifestPath(opts), manifest);
}

export function getSkill(id: string, opts?: SkillPathsOpts): SkillManifestEntry | null {
  return loadManifest(opts).skills.find((s) => s.id === id) ?? null;
}

function writeSkillMd(id: string, name: string, description: string, instructions: string, opts?: SkillPathsOpts): void {
  const dir = skillContentDir(id, opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), generateSkillMd(name, description, instructions), 'utf8');
}

/** Read a skill's current instructions body from its SKILL.md. */
export function readInstructions(id: string, opts?: SkillPathsOpts): string {
  const md = path.join(skillContentDir(id, opts), 'SKILL.md');
  if (!fs.existsSync(md)) return '';
  return stripFrontmatter(fs.readFileSync(md, 'utf8')).trim();
}

export interface CreateSkillInput {
  /** Stable id for built-in seeds; a UUID is generated when omitted. */
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  builtIn: boolean;
}

export function createSkill(input: CreateSkillInput, instructions: string, opts?: SkillPathsOpts): SkillManifestEntry {
  const now = Date.now();
  const entry: SkillManifestEntry = {
    id: input.id ?? randomUUID(),
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    builtIn: input.builtIn,
    createdAt: now,
    updatedAt: now,
  };
  writeSkillMd(entry.id, entry.name, entry.description, instructions, opts);
  const manifest = loadManifest(opts);
  manifest.skills.push(entry);
  saveManifest(manifest, opts);
  if (entry.enabled) syncSkill(entry.id, opts);
  return entry;
}

export interface UpdateSkillPatch {
  name?: string;
  description?: string;
  instructions?: string;
}

export function updateSkill(id: string, patch: UpdateSkillPatch, opts?: SkillPathsOpts): SkillManifestEntry {
  const manifest = loadManifest(opts);
  const entry = manifest.skills.find((s) => s.id === id);
  if (!entry) throw new SkillNotFoundError(id);

  if (patch.name !== undefined) entry.name = patch.name;
  if (patch.description !== undefined) entry.description = patch.description;
  entry.updatedAt = Date.now();

  // name/description live in the frontmatter, so rewrite SKILL.md whenever any
  // field changes; instructions come from the patch or the existing file body.
  const instructions = patch.instructions ?? readInstructions(id, opts);
  writeSkillMd(entry.id, entry.name, entry.description, instructions, opts);

  saveManifest(manifest, opts);
  if (entry.enabled) syncSkill(entry.id, opts);
  return entry;
}

export function toggleSkill(id: string, enabled: boolean, opts?: SkillPathsOpts): SkillManifestEntry {
  const manifest = loadManifest(opts);
  const entry = manifest.skills.find((s) => s.id === id);
  if (!entry) throw new SkillNotFoundError(id);

  entry.enabled = enabled;
  entry.updatedAt = Date.now();
  saveManifest(manifest, opts);

  if (enabled) syncSkill(id, opts);
  else removeSkillSyncDir(id, opts);
  return entry;
}

export function deleteSkill(id: string, opts?: SkillPathsOpts): void {
  const manifest = loadManifest(opts);
  const idx = manifest.skills.findIndex((s) => s.id === id);
  if (idx < 0) return; // idempotent

  removeSkillSyncDir(id, opts);
  fs.rmSync(skillContentDir(id, opts), { recursive: true, force: true });
  manifest.skills.splice(idx, 1);
  saveManifest(manifest, opts);
}

/** Full reconcile of `~/.claude/skills/` against the manifest (startup + drift repair). */
export function reconcile(opts?: SkillPathsOpts): void {
  const manifest = loadManifest(opts);
  reconcileSync(manifest.skills.filter((s) => s.enabled).map((s) => s.id), opts);
}
