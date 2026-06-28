import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/core/skill-installer.js';

/**
 * The wiki operations (build/ingest/lint/save) are shipped as builtin Claude
 * Code skills so the agent invokes them on demand by intent (构建/入库/健康检查/
 * 归档), replacing the old daemon-side wikiOperation prompt-prepend path.
 *
 * These tests install the builtin skills into a temp vault (the installer's own
 * source-dir resolution handles dev/prod/packaged layouts) and assert each
 * wiki skill landed with valid frontmatter + trigger keywords.
 */

const WIKI_SKILLS = ['wiki-build', 'wiki-ingest', 'wiki-lint', 'wiki-save'];

describe('builtin wiki operation skills', () => {
  // Install synchronously at describe-registration time so the inner describe
  // blocks can build their SKILL.md paths (a `before` hook would run too late).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-wiki-skill-test-'));
  installBuiltinSkills(tmpDir);
  const skillsDir = path.join(tmpDir, '.claude', 'skills');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const name of WIKI_SKILLS) {
    describe(`${name} skill`, () => {
      const skillMdPath = path.join(skillsDir, name, 'SKILL.md');

      it('is installed with name + description frontmatter', () => {
        assert.ok(fs.existsSync(skillMdPath), `missing installed ${skillMdPath}`);
        const content = fs.readFileSync(skillMdPath, 'utf8');

        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        assert.ok(fmMatch, 'SKILL.md should start with YAML frontmatter');
        const frontmatter = fmMatch![1]!;

        assert.match(frontmatter, new RegExp(`name:\\s*${name}\\b`), 'frontmatter name must match skill dir');
        assert.match(frontmatter, /description:\s*[\s\S]/, 'frontmatter must have a description');
      });

      it('lists trigger keywords so the agent can route intent', () => {
        const content = fs.readFileSync(skillMdPath, 'utf8');
        // Each wiki skill's description must advertise its trigger verbs so
        // chat-typed commands (入库/构建/健康检查/归档) hit the skill reliably.
        assert.match(content, /Triggers on:/i, 'description should list "Triggers on:" keywords');
      });
    });
  }
});
