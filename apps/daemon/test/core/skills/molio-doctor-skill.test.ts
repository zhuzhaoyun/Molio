import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillMd } from '@molio/contracts';
import {
  BUILTIN_SKILLS,
  reconcileBundledSync,
  resolveSkillsSourceDir,
} from '../../../src/core/skill-installer.js';

const tempDirs: string[] = [];

/** Local helper: read the shipped molio-doctor SKILL.md from the bundled source. */
function read(): string {
  return fs.readFileSync(path.join(resolveSkillsSourceDir(), 'molio-doctor', 'SKILL.md'), 'utf8');
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bundled molio-doctor skill', () => {
  it('is registered as a built-in skill', () => assert.ok(BUILTIN_SKILLS.includes('molio-doctor')));

  it('ships a SKILL.md pinned to 1.0.0 with a trigger segment', () => {
    const parsed = parseSkillMd(read());
    assert.equal(parsed.name, 'molio-doctor');
    assert.match(read(), /^version: 1\.0\.0$/m);
    assert.ok(parsed.description.includes('Triggers on:'));
    assert.ok(parsed.description.includes('Failed to fetch') && parsed.description.includes('体检'));
  });

  it('pins the read-only, no-fabrication and shell-portability disciplines', () => {
    const text = read();
    for (const needle of ['只读', '不要凭猜测下结论', '不要编造', '$MOLIO_API_BASE', 'curl.exe', 'http://localhost:3100', '3758096392', 'support-bundle', 'sse-debug.log']) {
      assert.ok(text.includes(needle), needle);
    }
  });

  it('syncs into a vault as a whole directory', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-doctor-'));
    tempDirs.push(vault);
    reconcileBundledSync(new Set(['molio-doctor']), new Set(['molio-doctor']), vault);
    assert.ok(fs.existsSync(path.join(vault, '.claude', 'skills', 'molio-doctor', 'SKILL.md')));
  });
});
