import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for cjk-emphasis-check.mjs — the deterministic scanner for
 * CJK emphasis breakage: under CommonMark flanking rules a `**` run touching
 * punctuation on one side and a CJK letter on the other neither opens nor
 * closes, so `**生态位（萝卜坑）**的分配` renders the asterisks literally
 * (reproduced from a real lint finding in 排版预览).
 *
 * CommonMark "punctuation" = Unicode general categories P + S (so ¥, emoji,
 * arrows all count); line start/end count as whitespace.
 *
 * Drives the real CLI via spawnSync (same convention as wiki-build-prep tests).
 * Each test gets its own fresh vault — no shared state, no order dependence.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveScriptPath(): string {
  const candidates = [
    // compiled run: dist/test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'cjk-emphasis-check.mjs'),
    // tsx run: test/tools/ → app root → src/tools/skills/
    path.join(__dirname, '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', 'cjk-emphasis-check.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`cjk-emphasis-check.mjs not found; tried:\n${candidates.join('\n')}`);
}
const SCRIPT = resolveScriptPath();

interface Issue {
  rel: string;
  line: number;
  side: 'open' | 'close' | 'both';
  pair: string;
  context: string;
}

interface Report {
  fileCount: number;
  issueCount: number;
  issues: Issue[];
}

let vault = '';

function writeDoc(rel: string, content: string): void {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function run(): Report {
  const r = spawnSync(process.execPath, [SCRIPT, '--vault', vault], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `scanner must always exit 0 (soft report): ${r.stderr}`);
  return JSON.parse(r.stdout) as Report;
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-cjk-emphasis-test-'));
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('cjk-emphasis-check', () => {
  // ---- 输出契约与 exit 0 健壮性 ----

  it('returns an empty report with the full contract shape when the vault has no wiki dir', () => {
    assert.deepEqual(run(), { fileCount: 0, issueCount: 0, issues: [] });
  });

  it('still exits 0 with valid JSON when wiki/ is a regular file', () => {
    // 回归：wiki 路径是普通文件时 readdirSync 曾抛 ENOTDIR → exit 1，违反恒 exit 0 契约
    fs.writeFileSync(path.join(vault, 'wiki'), 'not a directory');
    const r = spawnSync(process.execPath, [SCRIPT, '--vault', vault], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, `contract "恒 exit 0" violated: ${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { fileCount: 0, issueCount: 0, issues: [] });
  });

  it('exits 0 with an empty report for a nonexistent vault path', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--vault', path.join(vault, 'no-such')], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { fileCount: 0, issueCount: 0, issues: [] });
  });

  it('fileCount counts scanned files, not just files with issues', () => {
    writeDoc('wiki/clean.md', '正常 **加粗** 文本。\n');
    writeDoc('wiki/broken.md', '而是**生态位（萝卜坑）**的\n');
    const report = run();
    assert.equal(report.fileCount, 2);
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.rel, 'wiki/broken.md');
  });

  it('every issue carries exactly rel/line/side/pair/context', () => {
    writeDoc('wiki/concepts/a.md', '而是**生态位（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issues.length, report.issueCount);
    assert.deepEqual(Object.keys(report.issues[0]!).sort(), ['context', 'line', 'pair', 'rel', 'side']);
  });

  it('truncates pair to 57 chars + ellipsis beyond 60', () => {
    const inner = '生态位' + '萝卜坑'.repeat(30) + '（）'; // m[0] 共 99 字符 > 60
    writeDoc('wiki/concepts/a.md', `而是**${inner}**的分配\n`);
    const issue = run().issues[0]!;
    assert.equal(issue.pair.length, 58);
    assert.ok(issue.pair.endsWith('…'));
  });

  it('context spans ±20 chars with newlines folded to ⏎', () => {
    const pre = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'; // 恰好 20 字
    writeDoc('wiki/concepts/a.md', `${pre}而是**生态位（萝卜坑）**的分配\n下一行\n`);
    assert.equal(
      run().issues[0]!.context,
      '三四五六七八九十甲乙丙丁戊己庚辛壬癸而是**生态位（萝卜坑）**的分配⏎下一行⏎',
    );
  });

  // ---- side 分类（open / close / both 各自的形状都要锁住）----

  it('flags close-side failure: bold ending in ） followed by CJK letter', () => {
    writeDoc('wiki/concepts/a.md', '一句话：而是**生态位（萝卜坑）**的分配与支撑。\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
    assert.equal(report.issues[0]!.rel, 'wiki/concepts/a.md');
    assert.equal(report.issues[0]!.line, 1);
    assert.equal(report.issues[0]!.pair, '**生态位（萝卜坑）**');
  });

  it('flags both-side failure: bold wrapped in 「」 between CJK letters', () => {
    writeDoc('wiki/concepts/a.md', '甲**「重点」**乙\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'both');
  });

  it('flags open-side-only failure when closing ** sits at end of line', () => {
    // 行尾视同空白：闭合侧不失效，只有开启侧失效
    writeDoc('wiki/concepts/a.md', '甲**「重点」**\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'open');
  });

  it('pins the open-side fix shapes: space before opening ** is required', () => {
    // 双侧失效的正确修法是两侧都补空格
    writeDoc('wiki/concepts/a.md', '甲 **「重点」** 乙\n');
    assert.equal(run().issueCount, 0);
    // 只在闭合后补空格（旧的修复建议）仍然坏：开启侧依旧失效
    writeDoc('wiki/concepts/a.md', '甲**「重点」** 乙\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'open');
  });

  it('flags close-side failure when bold ends with a comma before CJK text', () => {
    writeDoc('wiki/concepts/a.md', '他说**没关系，**我觉得不行\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
  });

  // ---- Unicode S 类符号（¥/emoji/箭头）按 CommonMark P+S 口径判定 ----

  it('flags bold ending in a currency symbol before CJK text', () => {
    writeDoc('wiki/concepts/a.md', '**价格¥**的\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
  });

  it('flags bold starting with a currency symbol after a CJK letter', () => {
    writeDoc('wiki/concepts/a.md', '甲**¥99**乙\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'open');
  });

  it('accepts broken-looking bold followed by an S-class symbol (renders fine)', () => {
    // 👍 / → 属 Unicode S 类 = CommonMark 标点，闭合 ** 后贴它们时加粗正常生效
    writeDoc('wiki/concepts/a.md', '**说得好，**👍我觉得\n**结论。**→下一步\n');
    assert.equal(run().issueCount, 0);
  });

  it('detects emoji at bold edges by code point, not UTF-16 unit', () => {
    // 半个代理对既不是标点也不是文字；必须按码点取边缘字符才能识别 emoji = S 类标点
    writeDoc('wiki/concepts/a.md', '甲**👍重点**乙\n');
    let report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'open');
    writeDoc('wiki/concepts/a.md', '甲**重点👍**乙\n');
    report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
  });

  // ---- 并列加粗重配对豁免（CommonMark 定界符栈：失败的闭合符会重新当开启符）----

  it('suppresses close-side report when a later ** in the same paragraph re-pairs', () => {
    // marked 实际渲染为嵌套全粗，无字面 ** 残留——不是失效
    writeDoc('wiki/concepts/a.md', '**重点（关键点）**和**次重点**\n');
    assert.equal(run().issueCount, 0);
  });

  it('still reports the last broken pair when the chain cannot fully re-pair', () => {
    // marked 输出 `**a（b）<strong>的</strong>c（d）**x`：确实有字面 ** 残留。
    // 第一对的 close 被后面的 ** 豁免，最后一对无处可配 → 报 close
    writeDoc('wiki/concepts/a.md', '**a（b）**的**c（d）**x\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
    assert.equal(report.issues[0]!.pair, '**c（d）**');
  });

  // ---- 可接受写法（不应报）----

  it('accepts bold followed by punctuation', () => {
    writeDoc('wiki/concepts/a.md', '而是**生态位（萝卜坑）**，的分配\n');
    assert.equal(run().issueCount, 0);
  });

  it('accepts bold followed by a space', () => {
    writeDoc('wiki/concepts/a.md', '而是**生态位（萝卜坑）** 的分配\n');
    assert.equal(run().issueCount, 0);
  });

  it('accepts bold whose edges are letters', () => {
    writeDoc('wiki/concepts/a.md', '甲**重点**乙，还有**生态位萝卜坑**的。\n');
    assert.equal(run().issueCount, 0);
  });

  it('accepts bold ending in punctuation at end of line/file', () => {
    writeDoc('wiki/concepts/a.md', '总结：**萝卜坑。**\n');
    assert.equal(run().issueCount, 0);
  });

  it('accepts a punct-ended bold at EOF without trailing newline', () => {
    writeDoc('wiki/concepts/a.md', '总结：**萝卜坑。**'); // 无 \n：走 next === '' 分支
    assert.equal(run().issueCount, 0);
  });

  // ---- 跳过区间：frontmatter / 围栏 / 缩进代码 / 行内代码 ----

  it('skips fenced code blocks and inline code', () => {
    writeDoc(
      'wiki/concepts/a.md',
      '```\n而是**生态位（萝卜坑）**的\n```\n行内 `**生态位（萝卜坑）**的` 代码\n',
    );
    assert.equal(run().issueCount, 0);
  });

  it('skips tilde fences (~~~ and ~~~js)', () => {
    writeDoc('wiki/concepts/a.md', '~~~\n而是**生态位（萝卜坑）**的\n~~~\n');
    assert.equal(run().issueCount, 0);
    writeDoc('wiki/concepts/a.md', '~~~js\n而是**生态位（萝卜坑）**的\n~~~\n');
    assert.equal(run().issueCount, 0);
  });

  it('skips indented code blocks after a blank line', () => {
    writeDoc('wiki/concepts/a.md', '前文\n\n    而是**生态位（萝卜坑）**的\n');
    assert.equal(run().issueCount, 0);
  });

  it('reports indented text that continues a paragraph (no blank line, not code)', () => {
    // CommonMark：缩进代码块不能打断段落——紧跟段落的缩进行仍是正文
    writeDoc('wiki/concepts/a.md', '前文\n    而是**生态位（萝卜坑）**的\n');
    assert.equal(run().issueCount, 1);
  });

  it('skips code spans spanning multiple lines (equal-length backtick runs)', () => {
    // CommonMark 代码 span 允许跨行，且按等长反引号串配对
    writeDoc('wiki/concepts/a.md', '前文 `第一行\n而是**生态位（萝卜坑）**的` 后文\n');
    assert.equal(run().issueCount, 0);
  });

  it('skips frontmatter', () => {
    writeDoc(
      'wiki/concepts/a.md',
      '---\ntitle: "**生态位（萝卜坑）**的"\n---\n正文 **重点** 无问题。\n',
    );
    assert.equal(run().issueCount, 0);
  });

  it('skips frontmatter behind a BOM (Windows editors)', () => {
    writeDoc(
      'wiki/concepts/a.md',
      '\uFEFF---\ntitle: "**生态位（萝卜坑）**的"\n---\n正文 **重点** 无问题。\n',
    );
    assert.equal(run().issueCount, 0);
  });

  it('flags a broken bold on the first body line after frontmatter', () => {
    writeDoc('wiki/concepts/a.md', '---\ntitle: ok\n---\n而是**生态位（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.line, 4); // frontmatter 行计入行号
  });

  it('flags a broken bold immediately after a closing fence', () => {
    writeDoc('wiki/concepts/a.md', '```\ncode\n```\n而是**生态位（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.line, 4);
  });

  // ---- 转义与星号串守卫 ----

  it('skips escaped delimiters and bold-italic runs', () => {
    writeDoc('wiki/concepts/a.md', '\\**生态位（萝卜坑）**的\n***生态位（萝卜坑）***的\n');
    assert.equal(run().issueCount, 0);
  });

  it('skips a bold pair followed by a third asterisk on the right', () => {
    writeDoc('wiki/concepts/a.md', '**生态位（萝卜坑）***的\n'); // 触发 content[end]==="*" 分支
    assert.equal(run().issueCount, 0);
  });

  it('treats an even backslash run as escaped backslash, not escaped delimiter', () => {
    writeDoc('wiki/concepts/a.md', '\\\\**生态位（萝卜坑）**的\n'); // 两个反斜杠 → 不转义 → 应报
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
  });

  // ---- 配对边界与行号 ----

  it('detects bold spanning a soft line break, line = pair start', () => {
    writeDoc('wiki/concepts/a.md', '而是**生态位\n（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
    assert.equal(report.issues[0]!.line, 1); // 行号取配对起始，不是收尾
  });

  it('does not pair across a blank line', () => {
    writeDoc('wiki/concepts/a.md', '**生态位\n\n（萝卜坑）**的分配\n');
    assert.equal(run().issueCount, 0);
  });

  it('reports the correct line number', () => {
    writeDoc('wiki/concepts/a.md', '第一行\n第二行\n而是**生态位（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.line, 3);
  });

  it('reports the correct line number with CRLF endings', () => {
    writeDoc('wiki/concepts/a.md', '第一行\r\n第二行\r\n而是**生态位（萝卜坑）**的分配\r\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.line, 3);
  });

  it('documents pairing rule: inner containing a single * never matches', () => {
    writeDoc('wiki/concepts/a.md', '甲**「重*点」**乙\n');
    assert.equal(run().issueCount, 0); // 保守漏报，翻转需改 pairRe
  });

  it('skips pairs longer than MAX_PAIR_LEN=2000 within one paragraph', () => {
    const inner2000 = '生' + '态'.repeat(1998) + '（'; // 恰好 2000 字符，标点收尾
    writeDoc('wiki/concepts/a.md', `甲**${inner2000}**的\n`);
    assert.equal(run().issueCount, 1); // 2000 仍报
    writeDoc('wiki/concepts/a.md', `甲**${inner2000}（**的\n`); // 2001 字符
    assert.equal(run().issueCount, 0); // 超限跳过
  });

  it('collects issues across files and sorts by path then line', () => {
    writeDoc('wiki/concepts/b.md', '乙**「甲」**丙\n');
    // 空行分段：若两条失效加粗在同一段落，前一条的闭合侧会被后一对的 ** 重配对豁免
    writeDoc('wiki/concepts/a.md', '而是**生态位（萝卜坑）**的\n\n他说**没关系，**我觉得\n');
    const report = run();
    assert.equal(report.fileCount, 2);
    assert.equal(report.issueCount, 3);
    assert.deepEqual(
      report.issues.map((i) => [i.rel, i.line]),
      [['wiki/concepts/a.md', 1], ['wiki/concepts/a.md', 3], ['wiki/concepts/b.md', 1]],
    );
  });
});
