import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installAll } from '../helpers/install-all.js';

/**
 * The wiki operations (build/ingest/lint/save) are shipped as builtin Claude
 * Code skills so the agent invokes them on demand by intent (构建/入库/健康检查/
 * 归档), replacing the old daemon-side wikiOperation prompt-prepend path.
 *
 * These tests install the builtin skills into a temp vault (the installer's own
 * source-dir resolution handles dev/prod/packaged layouts) and assert each
 * wiki skill landed with valid frontmatter + trigger keywords.
 */

const WIKI_SKILLS = ['wiki-build', 'wiki-ingest', 'wiki-lint', 'wiki-save', 'wiki-query'];

describe('builtin wiki operation skills', () => {
  // Install synchronously at describe-registration time so the inner describe
  // blocks can build their SKILL.md paths (a `before` hook would run too late).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-wiki-skill-test-'));
  installAll(tmpDir);
  const skillsDir = path.join(tmpDir, '.claude', 'skills');

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const readFrontmatter = (name: string): string => {
    const content = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    // Tolerate CRLF (Windows CI checks out with core.autocrlf=true).
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fmMatch, `${name} SKILL.md should start with YAML frontmatter`);
    return fmMatch![1]!;
  };

  for (const name of WIKI_SKILLS) {
    describe(`${name} skill`, () => {
      const skillMdPath = path.join(skillsDir, name, 'SKILL.md');

      it('is installed with name + description frontmatter', () => {
        assert.ok(fs.existsSync(skillMdPath), `missing installed ${skillMdPath}`);
        const content = fs.readFileSync(skillMdPath, 'utf8');

        assert.match(content, new RegExp(`name:\\s*${name}\\b`), 'frontmatter name must match skill dir');
        assert.match(content, /description:\s*[\s\S]/, 'frontmatter must have a description');
      });

      it('lists trigger keywords so the agent can route intent', () => {
        const content = fs.readFileSync(skillMdPath, 'utf8');
        // Each wiki skill's description must advertise its trigger verbs so
        // chat-typed commands (入库/构建/健康检查/归档) hit the skill reliably.
        assert.match(content, /Triggers on:/i, 'description should list "Triggers on:" keywords');
      });

      it('has exactly one version key and no stray fence lines in frontmatter', () => {
        const frontmatter = readFrontmatter(name);
        const versionLines = frontmatter.split(/\r?\n/).filter((line) => /^version:\s*/.test(line));
        assert.equal(
          versionLines.length,
          1,
          `${name} frontmatter must contain exactly one version: key (a duplicate is a merge-conflict artifact)`
        );
        assert.ok(!frontmatter.includes('```'), `${name} frontmatter must not contain a stray code-fence line (merge artifact)`);
      });
    });
  }

  describe('wiki skill version discipline', () => {
    // apps/daemon/CLAUDE.md: wiki-* 五件套（build/query/ingest/save/lint）
    // 同版本号共进——改任一 skill 时五个 version 一起 bump 到同一版本。
    it('all five wiki skills share the same version', () => {
      const versions = WIKI_SKILLS.map((name) => {
        const match = readFrontmatter(name).match(/^version:\s*(\S+)/m);
        assert.ok(match, `${name} frontmatter must have a version`);
        return `${name}=${match![1]}`;
      });
      const unique = new Set(versions.map((entry) => entry.split('=')[1]));
      assert.equal(unique.size, 1, `wiki-* skills must share one version, got: ${versions.join(', ')}`);
    });
  });
});
