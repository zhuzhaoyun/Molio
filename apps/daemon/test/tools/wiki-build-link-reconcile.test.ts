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
      writeWiki('entities/王五.md', FRONTMATTER('王五') + '# 王五\n\n过客王五，三哥曾救我，又见婉儿。\n');
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
      // 三哥/婉儿 must appear sentence-initial / before punctuation here: the
      // CJK embedded-word guard (issue #257) skips short aliases glued between
      // Han characters on both sides, so "素闻三哥义名" would no longer wrap.
      writeWiki('entities/王五.md', FRONTMATTER('王五') + '# 王五\n\n过客王五，三哥曾救我，又见婉儿。\n');
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

/**
 * Regression coverage for issue #257 — two systematic link damages found on a
 * Chinese vault (~212 pages):
 *   1. CJK embedded-wrap: short aliases got wrapped INSIDE unrelated words
 *      (核心理念 → 核[[心理与性格成长|心理]]念) because boundaryOK only
 *      rejected Latin neighbors. The CJK guard must skip them — 宁可漏链，
 *      不可错链.
 *   2. Legacy double-wrap residue [[T|Y]]Y]] from pre-idempotency linkpass
 *      versions — linkpass must collapse it to plain Y (and not re-wrap the
 *      freed alias); deadcheck must report it without failing the gate.
 */
describe('linkpass CJK guard + residue cleanup (issue #257)', () => {
  let vault2: string;
  const wikiFile2 = (rel: string) => path.join(vault2, 'wiki', rel);
  const writeWiki2 = (rel: string, content: string) => {
    const abs = wikiFile2(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  const readWiki2 = (rel: string) => fs.readFileSync(wikiFile2(rel), 'utf8');
  const batchesDir = () => path.join(vault2, 'batches');

  before(() => {
    vault2 = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-cjkguard-test-'));
    writeWiki2('concepts/计算机网络.md', FRONTMATTER('计算机网络') + '# 计算机网络\n\n计算机网络是互联的计算设备集合。\n');
    writeWiki2('concepts/心理与性格成长.md', FRONTMATTER('心理与性格成长') + '# 心理与性格成长\n\n心理与性格成长关注个体内在发展。\n');
    // Regression fixtures: 网络 is BOTH a page name and (via batches) an
    // alias of 计算机网络, present from the start — the bug-1 assertions must
    // hold regardless of which it() happens to create which page.
    writeWiki2('concepts/网络.md', FRONTMATTER('网络') + '# 网络\n\n网络是连接的结构。\n');
    writeWiki2('concepts/甲乙.md', FRONTMATTER('甲乙') + '# 甲乙\n\n甲乙是一个人。\n');
    writeWiki2('concepts/红楼梦.md', FRONTMATTER('红楼梦') + '# 红楼梦\n\n红楼梦是长篇小说。\n');
    writeWiki2('concepts/test-a.md', FRONTMATTER('test-a') + '# test-a\n\n《神经网络与深度学习》是经典教材。核心理念很重要。\n');
    writeWiki2('concepts/深度学习入门.md', FRONTMATTER('深度学习入门') + '# 深度学习入门\n\n本书讲解计算机网络基础，计算机网络很重要。\n');
    fs.mkdirSync(batchesDir(), { recursive: true });
    fs.writeFileSync(
      path.join(batchesDir(), 'batch-01.tsv'),
      '计算机网络\t概念\t别名: 网络\tx\tx\n心理与性格成长\t概念\t别名: 心理\tx\tx\n',
      'utf8',
    );
  });
  after(() => {
    fs.rmSync(vault2, { recursive: true, force: true });
  });

  it('does not wrap short CJK aliases embedded between Han characters (bug 1)', () => {
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);

    const a = readWiki2('concepts/test-a.md');
    // 网络.md exists (see before()) — the guard covers PAGE NAMES too: [[网络]]
    // would resolve to 网络.md, so wrapping it here is deadcheck-invisible
    // damage.
    assert.ok(a.includes('《神经网络与深度学习》'), `神经网络 must stay intact, got: ${a}`);
    assert.ok(a.includes('核心理念很重要'), `核心理念 must stay intact, got: ${a}`);
    assert.ok(!a.includes('[['), `embedded aliases must not be wrapped at all, got: ${a}`);

    // Long canonical names stay freely linkable even mid-sentence…
    const d = readWiki2('concepts/深度学习入门.md');
    assert.ok(d.includes('讲解[[计算机网络]]基础'), `canonical name should wrap, got: ${d}`);
    // …and the alias inside it is shielded by the longer name, not mis-wrapped.
    assert.ok(!d.includes('[[计算机网络|网络]]'), `alias inside canonical mention must not wrap, got: ${d}`);
    assert.equal(r.meta!.addedLinks, 1, `only the one canonical wrap expected, stderr: ${r.stderr}`);
  });

  it('collapses legacy [[T|Y]]Y]] residue to plain text without re-wrapping (bug 2)', () => {
    writeWiki2('concepts/test-residue.md', FRONTMATTER('test-residue') + '# test-residue\n\n《神经[[计算机网络|网络]]网络]]与深度学习》是经典教材。\n');
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.meta!.residueFixed, 1, `exactly one residue expected, stderr: ${r.stderr}`);
    const c = readWiki2('concepts/test-residue.md');
    assert.ok(c.includes('《神经网络与深度学习》'), `residue must collapse to plain text, got: ${c}`);
    assert.ok(!c.includes('[[计算机网络|网络]]'), `freed alias is CJK-embedded → must not re-wrap, got: ${c}`);
  });

  it('stays idempotent — re-run adds nothing, cleans nothing', () => {
    // Run twice ourselves and assert on the SECOND run: this case must not
    // borrow "the first run" from whichever test happened to execute before
    // it — run standalone or reordered, the second run is always a no-op.
    run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.meta!.addedLinks, 0, `stderr: ${r.stderr}`);
    assert.equal(r.meta!.residueFixed, 0, `stderr: ${r.stderr}`);
    assert.equal(r.meta!.editedFiles, 0, `stderr: ${r.stderr}`);
  });

  it('deadcheck reports residue without failing the gate', () => {
    writeWiki2('concepts/test-deadres.md', FRONTMATTER('test-deadres') + '# test-deadres\n\n决定学[[心理与性格成长|心理]]心理]]后。\n');
    const r = run(DEADCHECK, ['--vault', vault2]);
    assert.equal(r.status, 0, `residue is not a dead link — gate must stay green, stdout: ${r.stdout}`);
    assert.equal(r.meta!.residue, 1, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /residue/);
  });

  // A surface that is BOTH a page name and another page's alias
  // pushed two same-coordinate edits and stacked into fresh [[T|Y]]Y]] residue.
  it('collides page name with alias → single link, no residue, converges', () => {
    writeWiki2('concepts/p-collision.md', FRONTMATTER('p-collision') + '# p-collision\n\n网络很重要。\n');
    const r1 = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r1.status, 0, r1.stderr);
    const c = readWiki2('concepts/p-collision.md');
    assert.ok(!c.includes(']]网络]]'), `must not stack into residue, got: ${c}`);
    assert.ok(c.includes('[[网络]]很重要'), `page name wins over alias, got: ${c}`);
    assert.ok((r1.meta!.collidedAliases ?? []).includes('网络'), `collision must be reported, stderr: ${r1.stderr}`);
    const before = readWiki2('concepts/p-collision.md');
    const r2 = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(readWiki2('concepts/p-collision.md'), before, 'second run must be byte-identical');
    assert.equal(r2.meta!.addedLinks, 0, `stderr: ${r2.stderr}`);
    assert.equal(r2.meta!.residueFixed, 0, `stderr: ${r2.stderr}`);
  });

  // Wrapping a neighbor inserts ]] and unblocks the guard next
  // run — the guard must look THROUGH links at their display text.
  it('guard verdicts are stable across runs when neighbors get wrapped', () => {
    writeWiki2('concepts/p-adjacent.md', FRONTMATTER('p-adjacent') + '# p-adjacent\n\n甲乙心理丙很重要。\n');
    const r1 = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r1.status, 0, r1.stderr);
    const c1 = readWiki2('concepts/p-adjacent.md');
    assert.ok(c1.includes('[[甲乙]]心理丙很重要'), `edge name wraps, embedded alias skipped, got: ${c1}`);
    const r2 = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r2.meta!.addedLinks, 0, `single run must converge, stderr: ${r2.stderr}`);
    const c2 = readWiki2('concepts/p-adjacent.md');
    assert.equal(c2, c1, 'second run must be byte-identical');
    assert.ok(!c2.includes('心理与性格成长|心理'), `心理丙 must never be split, got: ${c2}`);
  });

  // Residue cleanup must honor the never-touched regions.
  // Targets are existing pages (计算机网络/网络) so the quoted link — quotes DO
  // render links and stay dead-checked — never leaves a dead link in vault2.
  it('residue inside code fence / inline code / quotes is left untouched', () => {
    writeWiki2(
      'concepts/p-protected.md',
      FRONTMATTER('p-protected') + '# p-protected\n\n' +
      '```\n[[计算机网络|网络]]网络]]\n```\n\n' +
      '行内 `[[计算机网络|网络]]网络]]` 代码。\n\n' +
      '他说：「[[计算机网络|网络]]网络]]」。\n\n' +
      '正文见[[计算机网络|网络]]网络]]后。\n',
    );
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.meta!.residueFixed, 1, `only the prose residue may collapse, stderr: ${r.stderr}`);
    const c = readWiki2('concepts/p-protected.md');
    assert.ok(c.includes('```\n[[计算机网络|网络]]网络]]\n```'), `fence must stay byte-identical, got: ${c}`);
    assert.ok(c.includes('`[[计算机网络|网络]]网络]]`'), `inline code must stay byte-identical, got: ${c}`);
    assert.ok(c.includes('「[[计算机网络|网络]]网络]]」'), `citation must stay byte-identical, got: ${c}`);
    assert.ok(c.includes('正文见网络后'), `prose residue collapses, got: ${c}`);
  });

  // The guard covers page names AND aliases alike.
  // A ≤3-char Han page name glued between Han characters is a word fragment
  // exactly like an alias — and wrapping it is deadcheck-legal SILENT damage
  // (《神经[[网络]]与深度学习》 resolves to 网络.md, gate stays green).
  // 宁可漏链，不可错链: 我读红楼梦很多遍 simply gets no link — acceptable.
  it('canonical page names embedded between Han characters are NOT wrapped either', () => {
    writeWiki2('concepts/p-novel.md', FRONTMATTER('p-novel') + '# p-novel\n\n我读红楼梦很多遍。\n');
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    const c = readWiki2('concepts/p-novel.md');
    assert.ok(c.includes('我读红楼梦很多遍'), `embedded page name must stay plain, got: ${c}`);
    assert.ok(!c.includes('[['), `no link may be added, got: ${c}`);
  });

  // deadcheck's LINK scan must skip code spans too.
  // Inside a fence, [[...]] renders as literal text — neither a live link nor
  // a dead one. Otherwise a fence documenting the residue pattern becomes an
  // unfixable exit-1: linkpass is forbidden to touch code, and 甲 is nobody's
  // page. Residue in code is reported as an informational bucket, never
  // auto-cleaned.
  it('deadcheck treats code-fence content as literal text', () => {
    const vault4 = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-deadfence-test-'));
    try {
      const w4 = (rel: string, content: string) => {
        const abs = path.join(vault4, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      w4('concepts/p-fence.md', FRONTMATTER('p-fence') + '# p-fence\n\n文档示例：\n\n```\n[[甲|乙]]乙]] 与 [[不存在的页面]]\n```\n');
      const r = run(DEADCHECK, ['--vault', vault4]);
      assert.equal(r.status, 0, `a fence full of fake links must not fail the gate, stdout: ${r.stdout}`);
      assert.equal(r.meta!.deadTargets, 0, `stderr: ${r.stderr}`);
      assert.equal(r.meta!.residue, 0, `no prose residue, stderr: ${r.stderr}`);
      assert.equal(r.meta!.residueProtected, 1, `fence residue is reported as informational, stderr: ${r.stderr}`);
      assert.match(r.stdout, /byte-identical/);
    } finally {
      fs.rmSync(vault4, { recursive: true, force: true });
    }
  });

  // Nested residue exposes the next layer only after the outer one collapses
  // — cleanup must loop until stable within ONE run.
  // Independent vault: the asserted counts must belong to THIS case alone —
  // on a shared vault a vault-wide count would only hold by test order.
  it('nested residue converges in a single run', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-nested-res-test-'));
    try {
      const w = (rel: string, content: string) => {
        const abs = path.join(v, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      w('concepts/p-nested.md', FRONTMATTER('p-nested') + '# p-nested\n\n正文[[甲|乙]][[甲|乙]]乙]]]]收尾。\n');
      const r1 = run(LINKPASS, ['--vault', v]);
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(r1.meta!.residueFixed, 2, `both layers collapse in one run, stderr: ${r1.stderr}`);
      assert.equal(r1.meta!.residueTruncated, 0, `stderr: ${r1.stderr}`);
      const p = path.join(v, 'wiki', 'concepts', 'p-nested.md');
      const c = fs.readFileSync(p, 'utf8');
      assert.ok(c.includes('正文乙收尾。'), `got: ${c}`);
      const r2 = run(LINKPASS, ['--vault', v]);
      assert.equal(fs.readFileSync(p, 'utf8'), c, 'second run must be byte-identical');
      assert.equal(r2.meta!.residueFixed, 0, `stderr: ${r2.stderr}`);
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });

  // The 20-round cap is a real bound for pathological
  // nesting — a file that hits it must SAY so, not pretend it is clean.
  it('residue deeper than 20 layers is reported as truncated, finished on re-run', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-deep-res-test-'));
    try {
      const w = (rel: string, content: string) => {
        const abs = path.join(v, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      const nested = '[[甲|乙]]'.repeat(25) + '乙' + ']]'.repeat(25);
      w('concepts/p-deep.md', FRONTMATTER('p-deep') + '# p-deep\n\n正文' + nested + '收尾。\n');
      const r1 = run(LINKPASS, ['--vault', v]);
      assert.equal(r1.meta!.residueFixed, 20, `one run peels at most 20 layers, stderr: ${r1.stderr}`);
      assert.equal(r1.meta!.residueTruncated, 1, `must say "not done", stderr: ${r1.stderr}`);
      assert.match(r1.stdout, /re-run to continue/);
      const r2 = run(LINKPASS, ['--vault', v]);
      assert.equal(r2.meta!.residueFixed, 5, `the remaining 5 layers, stderr: ${r2.stderr}`);
      assert.equal(r2.meta!.residueTruncated, 0, `stderr: ${r2.stderr}`);
      assert.ok(fs.readFileSync(path.join(v, 'wiki', 'concepts', 'p-deep.md'), 'utf8').includes('正文乙收尾。'), 'fully collapsed');
      const r3 = run(LINKPASS, ['--vault', v]);
      assert.equal(r3.meta!.residueFixed, 0, `converged, stderr: ${r3.stderr}`);
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });

  // The cap check peeks after round 20: a nest of EXACTLY 20 layers converges
  // at the cap and must not raise a false "re-run" warning.
  it('exactly-20-layer residue converges without a false truncated warning', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-exact-res-test-'));
    try {
      const w = (rel: string, content: string) => {
        const abs = path.join(v, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      const nested = '[[甲|乙]]'.repeat(20) + '乙' + ']]'.repeat(20);
      w('concepts/p-exact.md', FRONTMATTER('p-exact') + '# p-exact\n\n正文' + nested + '收尾。\n');
      const r1 = run(LINKPASS, ['--vault', v]);
      assert.equal(r1.meta!.residueFixed, 20, `stderr: ${r1.stderr}`);
      assert.equal(r1.meta!.residueTruncated, 0, `exactly at the cap → converged, no warning, stderr: ${r1.stderr}`);
      assert.ok(!/WARNING/.test(r1.stdout), `stdout must not warn, got: ${r1.stdout}`);
      const r2 = run(LINKPASS, ['--vault', v]);
      assert.equal(r2.meta!.residueFixed, 0, `stderr: ${r2.stderr}`);
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });

  // Quotes/frontmatter RENDER links, so deadcheck still gates
  // on them — and since no tool may edit those regions (prep.mjs verify
  // needs them byte-identical), the only way out is creating the page.
  it('dead link inside a quote still fails the gate; creating the page clears it', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-quote-dead-test-'));
    try {
      const w = (rel: string, content: string) => {
        const abs = path.join(v, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      w('concepts/p-quote.md', FRONTMATTER('p-quote') + '# p-quote\n\n他说：「见[[不存在的甲]]」。\n');
      const r1 = run(DEADCHECK, ['--vault', v]);
      assert.equal(r1.status, 1, `quote dead link must fail the gate, stdout: ${r1.stdout}`);
      assert.equal(r1.meta!.deadTargets, 1, `stderr: ${r1.stderr}`);
      w('concepts/不存在的甲.md', FRONTMATTER('不存在的甲') + '# 不存在的甲\n\n占位页。\n');
      const r2 = run(DEADCHECK, ['--vault', v]);
      assert.equal(r2.status, 0, `a stub page is the way out, stdout: ${r2.stdout}`);
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });

  // Neighbor characters are read by CODE POINT, so ext-B Han neighbors
  // (𠀀…𠀁, each a surrogate pair in UTF-16) trigger the guard just like
  // BMP Han ones.
  it('guard reads ext-B Han neighbors as Han', () => {
    writeWiki2('concepts/p-extb.md', FRONTMATTER('p-extb') + '# p-extb\n\n𠀀心理𠀁很重要。\n');
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    const c = readWiki2('concepts/p-extb.md');
    assert.ok(c.includes('𠀀心理𠀁很重要。'), `ext-B neighbors must trigger the guard, got: ${c}`);
    assert.ok(!c.includes('[['), `got: ${c}`);
  });

  // --dry-run must not claim to have cleaned anything.
  it('--dry-run reports honestly and writes nothing', () => {
    writeWiki2('concepts/p-dry.md', FRONTMATTER('p-dry') + '# p-dry\n\n正文见[[甲|乙]]乙]]后。\n');
    const before = readWiki2('concepts/p-dry.md');
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir(), '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readWiki2('concepts/p-dry.md'), before, 'dry-run must not write');
    assert.match(r.stdout, /would clean/, `dry-run output must say "would clean", got: ${r.stdout}`);
    fs.rmSync(wikiFile2('concepts/p-dry.md'), { force: true });
  });

  it('--no-cjk-guard restores the legacy wrap-anywhere behavior', () => {
    const vault3 = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-noguard-test-'));
    try {
      const w3 = (rel: string, content: string) => {
        const abs = path.join(vault3, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      w3('concepts/心理与性格成长.md', FRONTMATTER('心理与性格成长') + '# 心理与性格成长\n\n心理与性格成长关注个体内在发展。\n');
      w3('concepts/t.md', FRONTMATTER('t') + '# t\n\n核心理念很重要。\n');
      fs.mkdirSync(path.join(vault3, 'batches'), { recursive: true });
      fs.writeFileSync(path.join(vault3, 'batches', 'b1.tsv'), '心理与性格成长\t概念\t别名: 心理\tx\tx\n', 'utf8');
      const r = run(LINKPASS, ['--vault', vault3, '--batches', path.join(vault3, 'batches'), '--no-cjk-guard']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        fs.readFileSync(path.join(vault3, 'wiki', 'concepts', 't.md'), 'utf8').includes('核[[心理与性格成长|心理]]念'),
        'guard off → embedded wrap happens (documenting legacy behavior)',
      );
    } finally {
      fs.rmSync(vault3, { recursive: true, force: true });
    }
  });

  // Emphasis markers are transparent to the guards, exactly like link syntax.
  // `精神**对数学**的发展` renders as the bolded word 对数学 — it is NOT a
  // standalone mention of 对数. Reading the raw `*` made the guard judge a
  // word-initial page name to be free-standing and wrap it into `[[对数]]学`:
  // deadcheck-invisible (对数.md exists) but a wrong sentence nonetheless.
  it('guards read through emphasis markers instead of raw * markup', () => {
    writeWiki2('concepts/对数.md', FRONTMATTER('对数') + '# 对数\n\n对数是指数的逆运算。\n');
    writeWiki2(
      'concepts/p-em.md',
      FRONTMATTER('p-em') + '# p-em\n\n《原本》体现的理性精神**对数学**的发展产生了深远影响。\n',
    );
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    const c = readWiki2('concepts/p-em.md');
    assert.ok(c.includes('**对数学**'), `对数学 must stay intact, got: ${c}`);
    assert.ok(!c.includes('[[对数]]'), `must not wrap the 对数 inside 对数学, got: ${c}`);
    fs.rmSync(wikiFile2('concepts/p-em.md'), { force: true });
    fs.rmSync(wikiFile2('concepts/对数.md'), { force: true });
  });

  // Wrapping the *left* neighbor must not re-open the question either: the
  // verdict has to read the same before and after, or the pass would keep
  // adding links on every run.
  it('emphasis verdict stays idempotent across runs', () => {
    writeWiki2('concepts/幂函数.md', FRONTMATTER('幂函数') + '# 幂函数\n\n函数在**幂函数**下的性质。\n');
    run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.meta!.addedLinks, 0, `re-run must add nothing, stderr: ${r.stderr}`);
    fs.rmSync(wikiFile2('concepts/幂函数.md'), { force: true });
  });

  it('reads linked neighbors through emphasis markers on subsequent passes', () => {
    writeWiki2('concepts/精神.md', FRONTMATTER('精神') + '# 精神\n');
    writeWiki2('concepts/对数.md', FRONTMATTER('对数') + '# 对数\n');
    writeWiki2('concepts/em-linked.md', FRONTMATTER('em-linked') + '# em-linked\n\n精神**对数学**的发展。\n');
    try {
      const first = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
      assert.equal(first.status, 0, first.stderr);
      const content = readWiki2('concepts/em-linked.md');
      assert.ok(content.includes('[[精神]]**对数学**'), content);
      const second = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readWiki2('concepts/em-linked.md'), content);
    } finally {
      for (const f of ['concepts/精神.md', 'concepts/对数.md', 'concepts/em-linked.md']) {
        fs.rmSync(wikiFile2(f), { force: true });
      }
    }
  });

  // The both-sides-Han test only fires with Han on BOTH sides, so a page name
  // that is the PREFIX of a longer word slips through whenever the left
  // neighbour is punctuation or a space: 平面向量 became [[平面]]向量,
  // 对数学 became [[对数]]学 (found live while reconciling a maths vault).
  // The vault names its own offenders in one small file rather than the script
  // carrying a subject-specific lexicon.
  it('honours the vault-side compound list for prefix mis-splits', () => {
    writeWiki2('concepts/对数.md', FRONTMATTER('对数') + '# 对数\n\n对数是指数的逆运算。\n');
    writeWiki2('concepts/平面.md', FRONTMATTER('平面') + '# 平面\n\n平面是无限延展的。\n');
    writeWiki2(
      'concepts/p-compound.md',
      FRONTMATTER('p-compound')
      // 左边的邻居必须是「非汉字」（空格 / 标点），才是真正的漏网形态：
      // 若写成「体现了对数学」，前邻的 了 本身就是汉字，旧防护已经拦住了，
      // 这条断言就跑不到新代码。
      + '# p-compound\n\n第六章 平面向量及其应用。\n\n本节讨论，对数学发展有影响。\n\n见[[平面]]与[[对数]]。\n',
    );
    fs.writeFileSync(
      wikiFile2('.linkpass-compounds.json'),
      JSON.stringify({ 对数: ['学'], 平面: ['向'] }),
      'utf8',
    );

    const r = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r.status, 0, r.stderr);
    const c = readWiki2('concepts/p-compound.md');
    assert.ok(c.includes('平面向量及其应用'), `平面向量 must stay intact, got: ${c}`);
    assert.ok(c.includes('对数学发展'), `对数学 must stay intact, got: ${c}`);
    assert.ok(!c.includes('[[平面]]向'), `must not split 平面向量, got: ${c}`);
    assert.ok(!c.includes('[[对数]]学'), `must not split 对数学, got: ${c}`);
    // 显式链接不因这条防护而被动过
    assert.ok(c.includes('见[[平面]]与[[对数]]'), `explicit links must survive, got: ${c}`);

    // 幂等：重跑不加也不删
    const r2 = run(LINKPASS, ['--vault', vault2, '--batches', batchesDir()]);
    assert.equal(r2.meta!.addedLinks, 0, `re-run must add nothing, stderr: ${r2.stderr}`);
    assert.equal(readWiki2('concepts/p-compound.md'), c, 're-run must not rewrite');

    for (const f of ['concepts/p-compound.md', 'concepts/对数.md', 'concepts/平面.md', '.linkpass-compounds.json']) {
      fs.rmSync(wikiFile2(f), { force: true });
    }
  });
});

// Attachment references written as a vault-relative path must resolve by that
// path. Resolution falls back to a vault-wide basename lookup, which is only
// safe while every basename is unique — a vault holding two books (each with
// its own images/<stem>/001.png) breaks that assumption immediately.
describe('attachment resolution — path-form references across sources', () => {
  it('a full vault-relative path is not "ambiguous" when another source shares the basename', () => {
    const v = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-attach-test-'));
    try {
      const w = (rel: string, content: string) => {
        const abs = path.join(v, 'wiki', rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      };
      w('images/甲册/001.png', 'x');
      w('images/乙册/001.png', 'x');
      w('concepts/a.md', FRONTMATTER('a') + '# a\n\n![[wiki/images/甲册/001.png]]\n');

      const r = run(DEADCHECK, ['--vault', v]);
      assert.equal(r.status, 0, `path-form embed must resolve, stdout: ${r.stdout}`);
      assert.equal(r.meta!.deadEmbeds, 0, `stderr: ${r.stderr}`);

      // …while a bare filename genuinely is ambiguous and must still be caught,
      // or the very check that motivated the path form would go silent.
      w('concepts/b.md', FRONTMATTER('b') + '# b\n\n![[001.png]]\n');
      const r2 = run(DEADCHECK, ['--vault', v]);
      assert.equal(r2.status, 1, `bare ambiguous name must still fail, stdout: ${r2.stdout}`);
      assert.equal(r2.meta!.deadEmbeds, 1, `stderr: ${r2.stderr}`);
    } finally {
      fs.rmSync(v, { recursive: true, force: true });
    }
  });
});
