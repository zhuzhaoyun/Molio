import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for the wiki-build link-reconciliation CLIs — the closing
 * gate of every build: deadcheck.mjs (dead-link audit, exit-1 gate) and
 * linkpass.mjs (deterministic missed-link repair, idempotent).
 *
 * Regression coverage for two bugs found while reconciling the 红楼梦 vault:
 *   1. linkpass was not idempotent — each re-run wrapped the NEXT plain
 *      occurrence ("first valid" instead of "the true first occurrence").
 *   2. linkpass corrupted H1 titles and self-name compounds — alias 元妃 got
 *      wrapped inside the page title "# 元妃省亲".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveScript(name: string): string {
  const candidates = [
    // compiled run: dist/test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', name),
    // tsx run: test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`${name} not found; tried:\n${candidates.join('\n')}`);
}
const DEADCHECK = resolveScript('deadcheck.mjs');
const LINKPASS = resolveScript('linkpass.mjs');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  meta: Record<string, any> | null;
}

function run(script: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  let meta: Record<string, any> | null = null;
  const lines = (r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith('{')) {
      try { meta = JSON.parse(lines[i]!); } catch { /* keep looking */ }
      if (meta) break;
    }
  }
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', meta };
}

const FRONTMATTER = (title: string) => `---\ntype: entity\ntitle: "${title}"\ncreated: 2026-08-15\nupdated: 2026-08-15\ntags:\n  - 测试\n---\n`;

describe('wiki-build link reconciliation (deadcheck + linkpass)', () => {
  let vault: string;

  const wikiFile = (rel: string) => path.join(vault, 'wiki', rel);
  const writeWiki = (rel: string, content: string) => {
    const abs = wikiFile(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  const readWiki = (rel: string) => fs.readFileSync(wikiFile(rel), 'utf8');

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-linkrecon-test-'));
  });
  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  describe('deadcheck — dead-link gate', () => {
    before(() => {
      writeWiki('entities/唐三.md', FRONTMATTER('唐三') + '# 唐三\n\n唐三与[[苏婉]]同行。唐三又见[[王五]]。\n');
      writeWiki('entities/苏婉.md', FRONTMATTER('苏婉') + '# 苏婉\n\n苏婉与[[唐三|三哥]]同路。\n');
      // 王五 has no page → dead link.
    });

    it('exits 1 and reports the dead target when links dangle', () => {
      const r = run(DEADCHECK, ['--vault', vault]);
      assert.equal(r.status, 1);
      assert.ok(r.meta, 'must emit JSON metadata on stderr');
      assert.equal(r.meta!.ok, false);
      assert.equal(r.meta!.deadTargets, 1);
      assert.match(r.stdout, /\[\[王五\]\]/);
    });

    it('exits 0 once the missing page exists', () => {
      writeWiki('entities/王五.md', FRONTMATTER('王五') + '# 王五\n\n过客王五，素闻三哥义名，又见婉儿。\n');
      const r = run(DEADCHECK, ['--vault', vault]);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(r.meta!.ok, true);
      assert.equal(r.meta!.deadTargets, 0);
    });

    it('resolves path-form and display-form links', () => {
      // [[entities/唐三]] and [[唐三|display]] must not count as dead.
      writeWiki('concepts/同行记.md', FRONTMATTER('同行记') + '# 同行记\n\n见[[entities/唐三]]与[[苏婉|婉儿]]。\n');
      const r = run(DEADCHECK, ['--vault', vault]);
      assert.equal(r.status, 0, r.stdout);
      fs.rmSync(wikiFile('concepts'), { recursive: true, force: true });
    });
  });

  describe('linkpass — deterministic missed-link repair', () => {
    before(() => {
      fs.writeFileSync(
        path.join(vault, 'aliases.json'),
        JSON.stringify({ '三哥': '唐三', '婉儿': '苏婉' }),
        'utf8',
      );
      writeWiki('entities/唐三.md', FRONTMATTER('唐三') + '# 唐三\n\n唐三自称三哥。三哥遇苏婉，苏婉同行。\n');
      writeWiki('entities/苏婉.md', FRONTMATTER('苏婉') + '# 苏婉\n\n「三哥且慢。」苏婉道。后来婉儿先走。\n');
      writeWiki('concepts/唐三出家.md', FRONTMATTER('唐三出家') + '# 唐三出家\n\n唐三出家是全书大事。此事与唐三相关。\n');
      writeWiki('INDEX.md', '# 索引\n\n唐三、苏婉页索引（此页不应被 linkpass 改动）。\n');
    });

    it('wraps first occurrences, aliases as [[canonical|alias]], self never linked', () => {
      const r = run(LINKPASS, ['--vault', vault, '--aliases', path.join(vault, 'aliases.json')]);
      assert.equal(r.status, 0, r.stderr);

      const tang = readWiki('entities/唐三.md');
      assert.ok(tang.includes('[[苏婉]]'), 'canonical mention should be wrapped');
      // Self-name and self-alias never linked on the entity's own page.
      assert.ok(tang.startsWith(FRONTMATTER('唐三') + '# 唐三\n'), 'H1 must stay untouched');
      assert.ok(!tang.includes('[[唐三]]'), 'no self-link allowed');
      assert.ok(!tang.includes('[[唐三|三哥]]'), 'self-alias must not be wrapped either');

      const su = readWiki('entities/苏婉.md');
      assert.ok(su.includes('「三哥且慢。」'), 'citation inside 「」 must stay byte-identical');
      assert.ok(!su.includes('[[唐三|三哥]]'), 'quoted mention must not be linked (first occurrence is quoted)');
      assert.ok(!su.includes('[[苏婉|婉儿]]'), 'self-alias must not be wrapped');

      // Third-party page: aliases wrap as [[canonical|alias]].
      const wang = readWiki('entities/王五.md');
      assert.ok(wang.includes('[[唐三|三哥]]'), `alias should wrap as canonical|alias, got: ${wang}`);
      assert.ok(wang.includes('[[苏婉|婉儿]]'), `second alias should wrap too, got: ${wang}`);

      assert.equal(readWiki('INDEX.md').includes('[['), false, 'navigational pages must not be rewritten');
    });

    it('is idempotent — re-run adds zero links (regression)', () => {
      const r = run(LINKPASS, ['--vault', vault, '--aliases', path.join(vault, 'aliases.json')]);
      assert.equal(r.status, 0);
      assert.equal(r.meta!.addedLinks, 0, `second run must be a no-op, stderr: ${r.stderr}`);
      assert.equal(r.meta!.editedFiles, 0);
    });

    it('never wraps an alias inside the page’s own name (regression: 元妃 in 元妃省亲)', () => {
      // Page 唐三出家 contains canonical 唐三 as a prefix of its own name.
      const page = readWiki('concepts/唐三出家.md');
      assert.ok(page.includes('# 唐三出家\n'), 'H1 title must not be wrapped');
      // First occurrence of 唐三 is inside the self-compound 唐三出家 → shielded.
      assert.ok(!page.includes('[[唐三]]出家'), 'self-compound must not be split by a link');
    });

    it('leaves frontmatter untouched', () => {
      const tang = readWiki('entities/唐三.md');
      assert.ok(tang.startsWith(FRONTMATTER('唐三')), 'frontmatter must remain byte-identical');
    });
  });
});
