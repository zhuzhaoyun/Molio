import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/core/skill-installer.js';

describe('installBuiltinSkills', () => {
  it('installs wechat-article-extractor skill to vault .claude/skills/', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-test-'));
    try {
      installBuiltinSkills(tmpDir);

      const skillDir = path.join(tmpDir, '.claude', 'skills', 'wechat-article-extractor');
      assert.ok(fs.existsSync(skillDir), 'skill directory should exist');

      const files = fs.readdirSync(skillDir);
      assert.ok(files.includes('SKILL.md'), 'should contain SKILL.md');
      assert.ok(files.includes('extract.js'), 'should contain extract.js');
      assert.ok(files.includes('package.json'), 'should contain package.json');

      const libDir = path.join(skillDir, 'lib');
      assert.ok(fs.existsSync(libDir), 'lib directory should exist');
      const libFiles = fs.readdirSync(libDir);
      assert.ok(libFiles.includes('errors.js'), 'should contain lib/errors.js');
      assert.ok(libFiles.includes('fetch.js'), 'should contain lib/fetch.js');
      assert.ok(libFiles.includes('parser.js'), 'should contain lib/parser.js');
      assert.ok(libFiles.includes('converter.js'), 'should contain lib/converter.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call does not overwrite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-skill-test-'));
    try {
      installBuiltinSkills(tmpDir);
      const skillMd = path.join(tmpDir, '.claude', 'skills', 'wechat-article-extractor', 'SKILL.md');
      const stat1 = fs.statSync(skillMd);

      installBuiltinSkills(tmpDir);
      const stat2 = fs.statSync(skillMd);

      assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'file should not be overwritten');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
