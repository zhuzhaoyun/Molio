import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadManifest,
  createSkill,
  updateSkill,
  toggleSkill,
  deleteSkill,
  readInstructions,
  getSkill,
  SkillNotFoundError,
} from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-store-claude-'));
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

describe('skills/store', () => {
  it('loadManifest returns empty when manifest missing', () => {
    assert.deepEqual(loadManifest(opts), { skills: [] });
  });

  it('createSkill writes SKILL.md with frontmatter + body and records manifest entry', () => {
    const entry = createSkill(
      { name: '写文章', description: '写一篇文章', enabled: false, builtIn: false },
      '先列大纲再展开。',
      opts,
    );
    assert.ok(entry.id, 'should assign an id');
    assert.equal(entry.builtIn, false);

    const md = fs.readFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'utf8');
    assert.ok(md.startsWith('---\n'), 'starts with frontmatter fence');
    assert.match(md, /^name: 写文章$/m);
    assert.match(md, /^description: 写一篇文章$/m);
    assert.match(md, /^version: 1\.0\.0$/m);
    assert.ok(md.includes('先列大纲再展开。'), 'body present');

    const manifest = loadManifest(opts);
    assert.equal(manifest.skills.length, 1);
    assert.equal(manifest.skills[0]?.id, entry.id);
  });

  it('createSkill uses provided id for built-ins', () => {
    const entry = createSkill(
      { id: 'my-builtin', name: 'X', description: '', enabled: false, builtIn: true },
      'body',
      opts,
    );
    assert.equal(entry.id, 'my-builtin');
  });

  it('createSkill with enabled=true syncs to ~/.claude/skills/molio--<id>', () => {
    const entry = createSkill(
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    const synced = path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md');
    assert.ok(fs.existsSync(synced), 'synced SKILL.md should exist');
  });

  it('createSkill with enabled=false does NOT sync', () => {
    const entry = createSkill(
      { name: 'S', description: '', enabled: false, builtIn: false },
      'body',
      opts,
    );
    const syncedDir = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    assert.ok(!fs.existsSync(syncedDir), 'should not be synced when disabled');
  });

  it('createSkill leaves no .tmp file behind (atomic write)', () => {
    createSkill({ name: 'S', description: '', enabled: false, builtIn: false }, 'body', opts);
    const tmp = path.join(molioHome, 'skills', 'manifest.json.tmp');
    assert.ok(!fs.existsSync(tmp), 'tmp file should be renamed away');
  });

  it('updateSkill rewrites frontmatter (name) and keeps instructions', () => {
    const entry = createSkill(
      { name: 'Old', description: 'd', enabled: true, builtIn: false },
      'KEEP-ME',
      opts,
    );
    updateSkill(entry.id, { name: 'New' }, opts);

    assert.equal(readInstructions(entry.id, opts), 'KEEP-ME');
    const md = fs.readFileSync(path.join(molioHome, 'skills', entry.id, 'SKILL.md'), 'utf8');
    assert.match(md, /^name: New$/m);
    // synced copy updated too
    const synced = fs.readFileSync(path.join(claudeHome, 'skills', `molio--${entry.id}`, 'SKILL.md'), 'utf8');
    assert.match(synced, /^name: New$/m);
  });

  it('updateSkill changes instructions body', () => {
    const entry = createSkill(
      { name: 'S', description: '', enabled: false, builtIn: false },
      'old body',
      opts,
    );
    updateSkill(entry.id, { instructions: 'new body' }, opts);
    assert.equal(readInstructions(entry.id, opts), 'new body');
  });

  it('updateSkill on unknown id throws SkillNotFoundError', () => {
    assert.throws(() => updateSkill('nope', { name: 'x' }, opts), SkillNotFoundError);
  });

  it('toggleSkill false removes sync dir, true re-adds it', () => {
    const entry = createSkill(
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    const syncedDir = path.join(claudeHome, 'skills', `molio--${entry.id}`);
    assert.ok(fs.existsSync(syncedDir));

    toggleSkill(entry.id, false, opts);
    assert.ok(!fs.existsSync(syncedDir), 'disabled removes sync dir');
    assert.equal(getSkill(entry.id, opts)?.enabled, false);

    toggleSkill(entry.id, true, opts);
    assert.ok(fs.existsSync(path.join(syncedDir, 'SKILL.md')), 're-enabled re-syncs');
  });

  it('deleteSkill removes content dir, sync dir, and manifest entry', () => {
    const entry = createSkill(
      { name: 'S', description: '', enabled: true, builtIn: false },
      'body',
      opts,
    );
    deleteSkill(entry.id, opts);
    assert.ok(!fs.existsSync(path.join(molioHome, 'skills', entry.id)));
    assert.ok(!fs.existsSync(path.join(claudeHome, 'skills', `molio--${entry.id}`)));
    assert.equal(loadManifest(opts).skills.length, 0);
  });

  it('deleteSkill on unknown id is a no-op', () => {
    assert.doesNotThrow(() => deleteSkill('nope', opts));
  });
});
