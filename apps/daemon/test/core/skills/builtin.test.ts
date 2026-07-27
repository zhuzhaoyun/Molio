import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { seedBuiltinSkills, initSkillLibrary, BUILTIN_SKILLS_SEEDS } from '../../../src/core/skills/builtin.js';
import { loadManifest, toggleSkill } from '../../../src/core/skills/store.js';
import type { SkillPathsOpts } from '../../../src/core/skills/paths.js';

let molioHome: string;
let claudeHome: string;
let opts: SkillPathsOpts;

beforeEach(() => {
  molioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-builtin-home-'));
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skills-builtin-claude-'));
  opts = { molioHome, claudeHome };
});

afterEach(() => {
  fs.rmSync(molioHome, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
});

describe('skills/builtin', () => {
  it('seedBuiltinSkills creates all seeds as built-in entries', () => {
    seedBuiltinSkills(opts);
    const manifest = loadManifest(opts);
    assert.equal(manifest.skills.length, BUILTIN_SKILLS_SEEDS.length);
    for (const s of manifest.skills) {
      assert.equal(s.builtIn, true);
    }
    const ids = manifest.skills.map((s) => s.id).sort();
    assert.deepEqual(ids, [...BUILTIN_SKILLS_SEEDS.map((s) => s.id)].sort());
  });

  it('seeding is idempotent — second call does not duplicate', () => {
    seedBuiltinSkills(opts);
    seedBuiltinSkills(opts);
    assert.equal(loadManifest(opts).skills.length, BUILTIN_SKILLS_SEEDS.length);
  });

  it('seeding preserves the user toggle state of an existing built-in', () => {
    seedBuiltinSkills(opts);
    const id = BUILTIN_SKILLS_SEEDS[0]?.id;
    assert.ok(id);
    toggleSkill(id!, false, opts); // user disables a built-in

    seedBuiltinSkills(opts); // re-seed (e.g. on restart)
    const entry = loadManifest(opts).skills.find((s) => s.id === id);
    assert.equal(entry?.enabled, false, 'user toggle must be preserved');
    assert.equal(loadManifest(opts).skills.length, BUILTIN_SKILLS_SEEDS.length);
  });

  it('initSkillLibrary seeds and syncs enabled built-ins to ~/.claude/skills', () => {
    initSkillLibrary(opts);
    const enabledSeed = BUILTIN_SKILLS_SEEDS.find((s) => s.enabled);
    assert.ok(enabledSeed);
    const synced = path.join(claudeHome, 'skills', `molio--${enabledSeed!.id}`, 'SKILL.md');
    assert.ok(fs.existsSync(synced), 'enabled built-in should be synced');
  });
});
