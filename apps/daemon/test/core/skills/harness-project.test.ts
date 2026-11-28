import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installHarnessProjectSkills } from '../../../src/core/skills/harness-project.js';
import { BUILTIN_SKILLS } from '../../../src/core/skill-installer.js';

test('DSH skills install inside the registered vault and respect existing project skills', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-dsh-project-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const vault = path.join(project, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: ../worktrees/test');
  const root = path.join(vault, '.agents', 'skills');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'wiki-query.md'), 'local override');
  installHarnessProjectSkills(vault);
  assert.ok(fs.existsSync(path.join(root, 'wiki-build/scripts/deadcheck.mjs')));
  const build = path.join(root, 'wiki-build/SKILL.md');
  fs.writeFileSync(build, 'project edits');
  installHarnessProjectSkills(vault);
  assert.equal(fs.readFileSync(build, 'utf8'), 'project edits');
  assert.ok(!fs.existsSync(path.join(root, 'wiki-query')));
  assert.equal(fs.readFileSync(path.join(root, 'wiki-query.md'), 'utf8'), 'local override');
  assert.ok(!fs.existsSync(path.join(project, '.agents')));
  assert.ok(fs.existsSync(path.join(vault, '.agents/.molio-vault')));
  assert.equal(fs.readdirSync(root).length, BUILTIN_SKILLS.length);
});
