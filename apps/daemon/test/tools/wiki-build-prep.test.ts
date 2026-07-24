import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for the wiki-build preprocessing CLI (prep.js) — the
 * deterministic half of the large-corpus build pipeline: encoding detection,
 * line normalization (incl. single-line dumps), structural segmentation,
 * entity census with fragment collapse, resume-safe artifacts, status and
 * quote verification.
 *
 * Drives the real CLI via spawnSync so the argv/exit-code/stderr-metadata
 * contract the SKILL.md relies on is what's under test.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** prep.mjs lives in the skill source tree (not compiled to dist/). */
function resolvePrepPath(): string {
  const candidates = [
    // compiled run: dist/test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'prep.mjs'),
    // tsx run: test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'prep.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`prep.mjs not found; tried:\n${candidates.join('\n')}`);
}
const PREP = resolvePrepPath();

interface PrepResult {
  status: number;
  stdout: string;
  stderr: string;
  meta: Record<string, any> | null;
}

function runPrep(args: string[]): PrepResult {
  const r = spawnSync(process.execPath, [PREP, ...args], { encoding: 'utf8' });
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

/** Single-line novel dump: 4 chapters × 40 paragraphs, no newlines anywhere. */
function singleLineNovel(): string {
  let t = '';
  for (const ch of ['一', '二', '三', '四']) {
    t += `第${ch}章 风起云涌。`;
    for (let p = 0; p < 40; p++) {
      t += '林凡站在山顶，苏婉站在山脚。林凡心中一动，苏婉微微一笑。';
      if (p % 8 === 0) t += '唐三又名唐三千，人称三哥。';
    }
  }
  return t;
}

describe('wiki-build prep.js', () => {
  let vault: string;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-prep-test-'));
  });
  after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  const outDir = () => path.join(vault, '.molio', 'wiki-build');
  const artifact = (name: string) => path.join(outDir(), name);

  describe('prepare — novel profile on a single-line UTF-8 dump', () => {
    let meta: Record<string, any>;

    before(() => {
      fs.mkdirSync(path.join(vault, 'raw'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'raw', 'novel.txt'), singleLineNovel(), 'utf8');
      const r = runPrep([path.join(vault, 'raw', 'novel.txt'), '--vault', vault]);
      assert.equal(r.status, 0, `prep failed: ${r.stderr}`);
      assert.ok(r.meta, 'prepare must emit JSON metadata on stderr');
      meta = r.meta!;
    });

    it('auto-selects the novel profile', () => {
      assert.equal(meta.profile, 'novel');
      assert.equal(meta.profileChosenBy, 'auto');
    });

    it('restores a line structure from the single-line dump', () => {
      const transcode = fs.readFileSync(artifact('transcode-novel.txt'), 'utf8');
      const lines = transcode.split('\n');
      assert.ok(lines.length > 8, `expected many normalized lines, got ${lines.length}`);
      // Title lines stand alone (separateTitleLines): a line that is exactly a chapter title.
      assert.ok(lines.some((l) => /^第一章 风起云涌。$/.test(l)), 'chapter-1 title should be its own line');
    });

    it('detects structural segments and groups ranges', () => {
      const seg = JSON.parse(fs.readFileSync(artifact('segments-novel.json'), 'utf8'));
      assert.equal(seg.segmented, true);
      assert.equal(seg.segments.length, 4);
      assert.match(seg.segments[0].title, /^第一章/);
      assert.match(seg.segments[3].title, /^第四章/);
      assert.ok(seg.ranges.length >= 1);
      // Every segment is covered by exactly one range, in order.
      const covered = seg.ranges.flatMap((r: any) => r.segs);
      assert.deepEqual(covered, [1, 2, 3, 4]);
    });

    it('collapses greedy-capture fragments into the real 2-char names', () => {
      const cands = fs.readFileSync(artifact('candidates-novel.md'), 'utf8').split('\n');
      const surfaces = cands.filter((l) => l.startsWith('- [ ]')).map((l) => l.replace(/^- \[ \] /, '').split(' ')[0]);
      assert.ok(surfaces.includes('林凡'), `林凡 missing from ${JSON.stringify(surfaces)}`);
      assert.ok(surfaces.includes('苏婉'));
      assert.ok(surfaces.includes('唐三'));
      // Fragments must be collapsed, not ranked.
      assert.ok(!surfaces.includes('林凡站'), '林凡站 should collapse into 林凡');
      assert.ok(!surfaces.includes('林凡心'), '林凡心 should collapse into 林凡');
      assert.ok(!surfaces.includes('苏婉微'), '苏婉微 should collapse into 苏婉');
    });

    it('blocks verb-phrase and honorific false positives', () => {
      const census = JSON.parse(fs.readFileSync(artifact('census-novel.json'), 'utf8'));
      const surfaces = census.rows.map((r: any) => r.surface);
      // 人称三哥: {1,2} prefix + CJK lookbehind must reject it.
      assert.ok(!surfaces.includes('人称三哥'));
    });

    it('extracts deduped alias hints', () => {
      const census = JSON.parse(fs.readFileSync(artifact('census-novel.json'), 'utf8'));
      const pairs = census.aliasHints.map((h: any) => `${h.a}|${h.b}`);
      assert.ok(pairs.includes('唐三|唐三千'), `alias pair missing: ${JSON.stringify(pairs)}`);
      assert.equal(pairs.filter((p: string) => p === '唐三|唐三千').length, 1, 'alias hints must be deduped');
    });

    it('seeds resume-safe progress + candidates artifacts', () => {
      const progress = fs.readFileSync(artifact('progress-novel.md'), 'utf8');
      assert.match(progress, /## L1 范围清单/);
      assert.match(progress, /- \[ \] R001/);
    });
  });

  describe('resume safety', () => {
    it('never clobbers an in-flight candidates/progress file without --force', () => {
      const candsPath = artifact('candidates-novel.md');
      const progressPath = artifact('progress-novel.md');
      const marker = '\n<!-- resume-sentinel -->\n';
      fs.appendFileSync(candsPath, marker, 'utf8');
      fs.appendFileSync(progressPath, marker, 'utf8');

      const r = runPrep([path.join(vault, 'raw', 'novel.txt'), '--vault', vault]);
      assert.equal(r.status, 0);
      assert.ok(fs.readFileSync(candsPath, 'utf8').includes('resume-sentinel'), 'candidates clobbered');
      assert.ok(fs.readFileSync(progressPath, 'utf8').includes('resume-sentinel'), 'progress clobbered');
      assert.equal(r.meta!.candidatesWritten, false);
      assert.equal(r.meta!.progressWritten, false);
    });

    it('regenerates both with --force', () => {
      const r = runPrep([path.join(vault, 'raw', 'novel.txt'), '--vault', vault, '--force']);
      assert.equal(r.status, 0);
      assert.ok(!fs.readFileSync(artifact('candidates-novel.md'), 'utf8').includes('resume-sentinel'));
      assert.equal(r.meta!.candidatesWritten, true);
      assert.equal(r.meta!.progressWritten, true);
    });
  });

  describe('status — mechanical completion check', () => {
    it('reports incomplete on a fresh build', () => {
      const r = runPrep(['status', path.join(vault, 'raw', 'novel.txt'), '--vault', vault]);
      assert.equal(r.status, 0);
      const st = JSON.parse(r.stdout);
      assert.ok(st.rangesTotal >= 1);
      assert.ok(st.candidatesTotal >= 3);
      assert.equal(st.complete, false);
    });

    it('reports complete once all ranges and candidates are checked off', () => {
      for (const name of ['progress-novel.md', 'candidates-novel.md']) {
        const p = artifact(name);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/- \[ \]/g, '- [x]'), 'utf8');
      }
      const r = runPrep(['status', path.join(vault, 'raw', 'novel.txt'), '--vault', vault]);
      const st = JSON.parse(r.stdout);
      assert.equal(st.rangesDone, st.rangesTotal);
      assert.equal(st.candidatesDone, st.candidatesTotal);
      assert.equal(st.complete, true);
    });

    it('derives rangesDone from digest files, not checkboxes (real-world 761万字 build: 18 digests, 0 boxes)', () => {
      // Reset checkboxes to unchecked, then "run" L1 via digest files only —
      // exactly what Workflow subagents do (they write digests, never tick boxes).
      for (const name of ['progress-novel.md', 'candidates-novel.md']) {
        const p = artifact(name);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/- \[x\]/g, '- [ ]'), 'utf8');
      }
      const digestsDir = path.join(outDir(), 'digests');
      fs.mkdirSync(digestsDir, { recursive: true });
      try {
        // No digests yet → nothing done despite the progress file existing.
        let st = JSON.parse(runPrep(['status', path.join(vault, 'raw', 'novel.txt'), '--vault', vault]).stdout);
        assert.equal(st.rangesDone, 0);
        assert.equal(st.rangesChecked, 0);
        assert.equal(st.complete, false);

        // The single range's digest lands → rangesDone tracks the filesystem.
        fs.writeFileSync(path.join(digestsDir, 'R001.md'), '# R001 digest\n', 'utf8');
        st = JSON.parse(runPrep(['status', path.join(vault, 'raw', 'novel.txt'), '--vault', vault]).stdout);
        assert.equal(st.rangesDone, st.rangesTotal);
        assert.deepEqual(st.missingRanges, []);
        assert.equal(st.rangesChecked, 0, 'checkboxes remain untouched — digests are the truth');
        // candidates still unchecked → L2 not complete even though L1 is done.
        assert.equal(st.complete, false);
      } finally {
        fs.rmSync(digestsDir, { recursive: true, force: true });
      }
    });
  });

  describe('encoding detection', () => {
    it('detects GBK via CJK-ratio scoring and transcodes to UTF-8', {
      // Skip on ICU-less Node builds that lack the gb18030 codec.
      skip: (() => {
        try { new TextDecoder('gb18030'); return false; } catch { return 'TextDecoder lacks gb18030'; }
      })(),
    }, () => {
      // 中(D6D0) 国(B9FA) 一(D2BB) 天(CCEC) in GBK — invalid as UTF-8.
      const gbk: Record<string, number> = { '中': 0xd6d0, '国': 0xb9fa, '一': 0xd2bb, '天': 0xccec };
      const bytes: number[] = [];
      for (const c of '中中中国国国一一天天天') {
        bytes.push(gbk[c]! >> 8, gbk[c]! & 0xff);
      }
      fs.writeFileSync(path.join(vault, 'raw', 'gbk.txt'), Buffer.from(bytes));

      const r = runPrep([path.join(vault, 'raw', 'gbk.txt'), '--vault', vault]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.meta!.encoding, 'gb18030');
      const transcode = fs.readFileSync(artifact('transcode-gbk.txt'), 'utf8');
      assert.ok(transcode.includes('中国'), `transcode should contain 中国, got ${JSON.stringify(transcode)}`);
    });
  });

  describe('default profile — generic markdown source', () => {
    it('segments by headings and runs no entity census', () => {
      // Each section must clear minSegmentChars (200) or its heading is
      // treated as body of the previous segment.
      const md = [
        '# 第一部分',
        '这里是超过两百字的正文。'.repeat(25),
        '## 第二节',
        '更多正文内容填充。'.repeat(30),
        '## 第三节',
        '收尾的正文内容。'.repeat(30),
      ].join('\n');
      fs.writeFileSync(path.join(vault, 'raw', 'notes.md'), md, 'utf8');

      const r = runPrep([path.join(vault, 'raw', 'notes.md'), '--vault', vault]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.meta!.profile, 'default');
      const seg = JSON.parse(fs.readFileSync(artifact('segments-notes.json'), 'utf8'));
      assert.equal(seg.segmented, true);
      assert.equal(seg.segments.length, 3);
      assert.match(seg.segments[0].title, /^# 第一部分/);
      // No entityPatterns in the default profile → no candidates file.
      assert.equal(r.meta!.candidatesWritten, false);
      assert.ok(!fs.existsSync(artifact('candidates-notes.md')));
    });
  });

  describe('verify — quote spot-check against the transcode', () => {
    it('finds real quotes and flags fabricated ones', () => {
      const transcode = fs.readFileSync(artifact('transcode-novel.txt'), 'utf8');
      // A genuine quote: first 20 chars of chapter-2 body.
      const realQuote = transcode.replace(/\n/g, '').slice(50, 70);
      const page = [
        '# 林凡',
        '',
        '原文写道：',
        `「${realQuote}」`,
        '',
        '还有一句：',
        '「这句原文里绝对不存在的引文xyz」',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(vault, 'page.md'), page, 'utf8');

      const r = runPrep(['verify', path.join(vault, 'page.md'), artifact('transcode-novel.txt')]);
      assert.equal(r.status, 0, r.stderr);
      const v = JSON.parse(r.stdout);
      assert.equal(v.checked, 2);
      assert.equal(v.found, 1);
      assert.equal(v.missing.length, 1);
      assert.match(v.missing[0], /绝对不存在/);
    });
  });
});
