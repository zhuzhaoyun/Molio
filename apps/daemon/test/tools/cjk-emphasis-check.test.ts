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

  // ---- 并列/链式加粗重配对豁免（段落级定界符栈模拟）----

  it('suppresses close-side report when a later ** in the same paragraph re-pairs', () => {
    // marked 实际渲染为嵌套全粗，无字面 ** 残留——不是失效
    writeDoc('wiki/concepts/a.md', '**重点（关键点）**和**次重点**\n');
    assert.equal(run().issueCount, 0);
  });

  it('suppresses the second pair when a failed closer re-pairs as opener (chained)', () => {
    // marked: <strong>（括号）<strong>和</strong>（另一个）</strong> 全粗无残留。
    // 第 2 对 opener 前贴文字、内容以（开篇，几何上是 openFail——但定界符栈里
    // 它作为 closer 与第 1 对失效的 closer 重配对成功，逐对豁免会在这里误报。
    writeDoc('wiki/concepts/a.md', '**（括号）**和**（另一个）**\n');
    assert.equal(run().issueCount, 0);
  });

  it('suppresses nested re-pairing where the regex pair straddles real delimiters', () => {
    // marked: <strong>a（<strong>b</strong>）c</strong> 全粗无残留。
    // 正则把 `**）c**` 当一对（真实栈里是两个 closer），几何 openFail——模拟不报。
    writeDoc('wiki/concepts/a.md', '**a（**b**）c**\n');
    assert.equal(run().issueCount, 0);
  });

  it('reports both residue pairs when the chain cannot fully re-pair', () => {
    // marked 输出 `**a（b）<strong>的</strong>c（d）**x`：开头 `**a（b）` 与结尾
    // `c（d）**x` 两处 ** 都字面残留（定界符栈模拟把两处都找回来；旧逐对豁免
    // 只报最后一对，漏了开头）。
    writeDoc('wiki/concepts/a.md', '**a（b）**的**c（d）**x\n');
    const report = run();
    assert.equal(report.issueCount, 2);
    assert.deepEqual(
      report.issues.map((i) => i.pair),
      ['**a（b）**', '**c（d）**'],
    );
    assert.ok(report.issues.every((i) => i.side === 'close'));
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
    // CommonMark 定界符不可跨段落配对
    writeDoc('wiki/concepts/a.md', '**生态位\n\n（萝卜坑）**的分配\n');
    assert.equal(run().issueCount, 0);
  });

  it('still reports a residue pair whose opener follows an orphan ** in a prior paragraph', () => {
    // 回归：正则 `[^*]+?` 允许跨空行配对，会把上一段的孤立 opener 和本段的 closer
    // 配成一对（`**（乙丙\n\n而是**`）——该 pair 被跳过时 lastIndex 已越过本段
    // opener，本段的真残留再也扫不到，整段漏报（marked 渲染两段都是字面 **）。
    writeDoc('wiki/concepts/a.md', '甲**（乙丙\n\n而是**生态位（萝卜坑）**的分配\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'close');
    assert.equal(report.issues[0]!.line, 3);
    assert.equal(report.issues[0]!.pair, '**生态位（萝卜坑）**');
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

  // ---- 段落边界：CRLF / 空格行 / Tab 行（与 marked 同口径）----
  //
  // 回归：段落起点曾用字面 lastIndexOf('\n\n')、终点用 /\n\s*\n/。CRLF 文件里
  // \r\n\r\n 不含 '\n\n'，起点恒退化为 0（整个文件前缀当一段）而终点仍按段落切，
  // 两端失衡 → 误报 + 漏报。本仓库 core.autocrlf=true，受控 .md 全是 CRLF，
  // 这是 Windows 主平台的常态路径。
  //
  // 段落分隔口径与产品渲染器 marked 对齐：**一整行只含空格**（不含 Tab）才算
  // 空行——marked 的 spaceLine 是 /^ +$/，Tab 行属缩进续行、不断段。

  /** 同一内容在 LF 与 CRLF 下必须给出同一份 issue 集合（行号不变，内容等长）。 */
  function assertLfCrlfParity(content: string): void {
    writeDoc('wiki/concepts/a.md', content);
    const lf = run();
    writeDoc('wiki/concepts/a.md', content.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    const crlf = run();
    const key = (r: Report) => r.issues.map((i) => `${i.line}|${i.side}|${i.pair}`);
    assert.deepEqual(key(crlf), key(lf), 'CRLF 与 LF 必须给同一份报告');
  }

  it('gives identical reports under LF and CRLF', () => {
    // 覆盖：干净段 + 真残留段 + 孤立 opener 段 + 链式段
    assertLfCrlfParity('前文提到 **正常加粗** 文字。\n\n而是**生态位（萝卜坑）**的分配\n');
    assertLfCrlfParity('甲**乙\n\n丙**「重点」**丁**戊\n');
    assertLfCrlfParity('**重点（关键点）**和**次重点**\n\n**a（**b**）c**\n');
    assertLfCrlfParity('甲**（乙丙\n\n而是**生态位（萝卜坑）**的分配\n');
  });

  it('does not let a prior paragraph opener pair with the next paragraph under CRLF', () => {
    // 回归（误报）：CRLF 下起点退化把第一段的 ** 并入第二段模拟，健康加粗被报。
    writeDoc('wiki/concepts/a.md', '前文提到 **术语（来源\r\n\r\n丙**丁**戊\r\n');
    assert.equal(run().issueCount, 0, 'marked 渲染 <strong>丁</strong>，不该报');
  });

  it('still finds a real residue pair after a prior paragraph under CRLF', () => {
    // 回归（漏报）：同一处失衡的反方向——LF 能报、CRLF 报不出。
    writeDoc('wiki/concepts/a.md', '甲**乙\r\n\r\n丙**「重点」**丁**戊\r\n');
    const report = run();
    assert.equal(report.issueCount, 1);
    assert.equal(report.issues[0]!.side, 'both');
    assert.equal(report.issues[0]!.line, 3);
  });

  it('treats a spaces-only line as a paragraph separator', () => {
    // marked：/^ +$/ 是空行 → 分段。第 2 段的健康加粗不该被第 1 段的 ** 污染。
    for (const sep of ['\n\n', '\n \n', '\n   \n', '\n    \n', '\r\n\r\n', '\r\n \r\n']) {
      writeDoc('wiki/concepts/a.md', `甲**乙${sep}丙**丁**戊\n`);
      assert.equal(run().issueCount, 0, `分隔符 ${JSON.stringify(sep)} 下不该报`);
    }
  });

  it('treats a tab-only line as paragraph continuation, not a separator', () => {
    // marked：Tab 行不算空行（是缩进续行）→ 不分段，整段渲染全粗、无字面 **。
    for (const sep of ['\n\t\n', '\n \t\n', '\r\n\t\r\n']) {
      writeDoc('wiki/concepts/a.md', `而是**生态位（萝卜坑）**的分配${sep}甲**重点**乙\n`);
      assert.equal(run().issueCount, 0, `Tab 行 ${JSON.stringify(sep)} 不该分段`);
    }
  });

  it('still reports a residue when a tab line joins two broken paragraphs', () => {
    // Tab 行不断段 → 两半属同一段，内容以标点收尾且后贴文字的 ** 仍应报
    writeDoc('wiki/concepts/a.md', '而是**生态位（萝卜坑）**的分配\n\t\n甲**重点（a）**乙\n');
    assert.equal(run().issueCount, 2);
  });

  // ---- 已知盲区（显式钉住，翻转时立刻可见）----

  it('documents blind spot: isolated delimiters without any closer are not scanned', () => {
    // marked 渲染确实是字面 **，但正则要求成对才扫得到；要覆盖需独立的未配对检测。
    for (const md of ['**（甲）', '（甲）**', '甲**（乙）', '甲**（乙\n']) {
      writeDoc('wiki/concepts/a.md', md + '\n');
      assert.equal(run().issueCount, 0, `${JSON.stringify(md)} 属已声明盲区`);
    }
  });

  it('documents blind spot: astral chars touching a delimiter diverge from the renderer', () => {
    // marked 的 flanking 正则按 UTF-16 码元取相邻字符，代理对被劈成半个 → 它自己
    // 把 `👍**「重点」**👍` 渲染成字面 **；本脚本按码点取（CommonMark 正确口径）
    // 判为正常 → 漏报。BMP 符号（★/¥/→）两边一致。注意：emoji 在加粗**内部**
    // 时（`甲**👍重点**乙`）两边一致、照报——那条由上面的码点用例覆盖。
    for (const md of ['👍**「重点」**👍', '😀**「重点」**😀']) {
      writeDoc('wiki/concepts/a.md', md + '\n');
      assert.equal(run().issueCount, 0, `${JSON.stringify(md)} 属已声明盲区（渲染器按码元取）`);
    }
    // emoji 与定界符之间隔着汉字时两边一致：照报（上面 §side 分类的码点用例亦覆盖）
    for (const md of ['👍甲**「重点」**乙', '甲**「重点」**乙👍']) {
      writeDoc('wiki/concepts/a.md', md + '\n');
      assert.equal(run().issueCount, 1, `${JSON.stringify(md)} 不是盲区，应照常报`);
    }
  });

  // ---- 规模回归：超大单段落不得退化成 O(pairs × 段长) ----

  it('scans a large single paragraph (long table) without quadratic blowup', () => {
    // 表格/无空行的列表是单个段落；曾经每个 pair 都重扫整段，6000 行表格要十几秒。
    // 现在按段落缓存模拟结果，同一段只算一次。阈值给足余量避免 CI 抖动误伤。
    const rows = Array.from({ length: 3000 }, (_, i) => `| **条目${i}** | 说明 |`).join('\n');
    writeDoc('wiki/concepts/a.md', `| 名称 | 说明 |\n|---|---|\n${rows}\n`);
    const t0 = Date.now();
    const report = run();
    const elapsed = Date.now() - t0;
    assert.equal(report.issueCount, 0);
    assert.ok(elapsed < 5000, `3000 行表格耗时 ${elapsed}ms，疑似回到二次方`);
  });

  // ---- 对抗性审查案例集 ----
  //
  // 来源：2026-10 独立审查会话构造的对抗输入集（含 baseline 失效形态、正常写法、
  // 链式/嵌套、段落边界、块级上下文、转义与星号串、奇数定界符），每条都用产品
  // 实际渲染器 marked v18 跑过差分，期望值取自实测。
  //
  // 列：[名称, 内容, 脚本应有条数, 各条 side（null = 无）, marked 是否渲染字面 **,
  //      是否属已声明盲区]
  //
  // 盲区条目（末列为 true）的 marked 会渲染出字面 `**`，但脚本有意不报——它们是
  // 显式声明的取舍而非回归：孤立定界符需要独立的未配对检测、跨空行配对、转义与
  // 三连星串、相邻四星、emoji 贴边（渲染器按码元取）、图片 alt 文本。翻转任一
  // 取舍都会让这张表变红，届时要么改实现、要么同步改这里的声明。

  const ADVERSARIAL: Array<[string, string, number, string | null, boolean, boolean]> = [
    ['close-paren-cjk', '而是**生态位（萝卜坑）**的分配与支撑。\n', 1, 'close', true, false],
    ['both-quote-cjk', '甲**「重点」**乙\n', 1, 'both', true, false],
    ['open-only', '甲**「重点」**\n', 1, 'open', true, false],
    ['comma-close', '他说**没关系，**我觉得不行\n', 1, 'close', true, false],
    ['yen-close', '**价格¥**的\n', 1, 'close', true, false],
    ['yen-open', '甲**¥99**乙\n', 1, 'open', true, false],
    ['star-punct-close', '甲**重点★**乙\n', 1, 'close', true, false],
    ['arrow-close', '甲**重点→**乙\n', 1, 'close', true, false],
    ['empty-inner-fail', '甲**重点 **乙\n', 1, 'close', true, false],
    ['leading-space-inner-fail', '甲** 重点**乙\n', 1, 'close', true, false],
    ['two-fail-same-para', '**价格¥**的**成本¥**的\n', 2, 'close+close', true, false],
    ['clean-punct-after', '而是**生态位（萝卜坑）**，的分配\n', 0, null, false, false],
    ['clean-space-after', '而是**生态位（萝卜坑）** 的分配\n', 0, null, false, false],
    ['clean-letter-edges', '甲**重点**乙，还有**生态位萝卜坑**的。\n', 0, null, false, false],
    ['clean-eol', '总结：**萝卜坑。**\n', 0, null, false, false],
    ['clean-space-both', '甲 **「重点」** 乙\n', 0, null, false, false],
    ['s-class-after', '**说得好，**👍我觉得\n**结论。**→下一步\n', 0, null, false, false],
    ['emoji-inner-open', '甲**👍重点**乙\n', 1, 'open', true, false],
    ['emoji-inner-close', '甲**重点👍**乙\n', 1, 'close', true, false],
    ['clean-eof-no-newline', '总结：**萝卜坑。**', 0, null, false, false],
    ['chain-both-close', '**重点（关键点）**和**次重点**\n', 0, null, false, false],
    ['chain-close-then-open', '**（括号）**和**（另一个）**\n', 0, null, false, false],
    ['nested-straddle', '**a（**b**）c**\n', 0, null, false, false],
    ['chain-broken-both-ends', '**a（b）**的**c（d）**x\n', 2, 'close+close', true, false],
    ['both-fail-two-pairs', '甲**「重点」**乙**「丙」**丁\n', 2, 'both+both', true, false],
    ['three-pairs-mixed', '甲**「a」**乙**b**丙**「c」**丁\n', 2, 'both+both', true, false],
    ['nested-real', '**重点（**次级重点**）尾**的\n', 0, null, false, false],
    ['crlf-basic', '第一行\r\n第二行\r\n而是**生态位（萝卜坑）**的分配\r\n', 1, 'close', true, false],
    ['crlf-orphan-prior-para', '甲**（乙丙\r\n\r\n而是**生态位（萝卜坑）**的分配\r\n', 1, 'close', true, false],
    ['crlf-two-paras', '**（甲\r\n\r\n乙**「丙」**丁\r\n', 1, 'both', true, false],
    ['crlf-clean-then-clean', '前文 **正常** 段落\r\n\r\n后文 **重点** 段落\r\n', 0, null, false, false],
    ['space-line-separator', '甲 **正常** 段\n \n丙 **重点** 段\n', 0, null, false, false],
    ['tab-line-not-separator', '而是**生态位（萝卜坑）**的分配\n\t\n甲**重点**乙\n', 0, null, false, false],
    ['softbreak-valid', '而是**生态位\n（萝卜坑）**的分配\n', 1, 'close', true, false],
    ['para1-clean-para2-broken', '**重点**正常。\n\n而是**生态位（萝卜坑）**的分配\n', 1, 'close', true, false],
    ['para1-broken-para2-broken', '而是**生态位（萝卜坑）**的\n\n他说**没关系，**我觉得\n', 2, 'close+close', true, false],
    ['orphan-opener-prior-para', '甲**（乙丙\n\n而是**生态位（萝卜坑）**的分配\n', 1, 'close', true, false],
    ['table-row', '| 甲 | 乙**「重点」**丙 |\n|---|---|\n| 1 | 2 |\n', 1, 'both', true, false],
    ['list-item', '- 甲**「重点」**乙\n- 丙**重点（a）**丁\n', 2, 'both+close', true, false],
    ['blockquote', '> 甲**「重点」**乙\n> 丙**重点（a）**丁\n', 2, 'both+close', true, false],
    ['heading', '## 甲**「重点」**乙\n', 1, 'both', true, false],
    ['html-tag', '甲<span>**「重点」**</span>乙\n', 0, null, false, false],
    ['link-syntax', '见[文档**「重点」**说明](http://a/b)\n', 1, 'both', true, false],
    ['autolink', '见 <http://a/b**「重点」**c>\n', 1, 'both', true, false],
    ['BS-isolated-delim', '甲**（乙）\n', 0, null, true, true],
    ['BS-no-pair-across-blank', '**生态位\n\n（萝卜坑）**的分配\n', 0, null, true, true],
    ['BS-odd-one-delim', '甲**（乙\n', 0, null, true, true],
    ['BS-escaped-open', '\\**生态位（萝卜坑）**的\n', 0, null, true, true],
    ['BS-triple-star', '***生态位（萝卜坑）***的\n', 0, null, true, true],
    ['BS-trailing-star', '**生态位（萝卜坑）***的\n', 0, null, true, true],
    ['BS-four-star-adjacent', '甲****重点（a）****乙\n', 0, null, true, true],
    ['BS-single-star-inside', '甲**「重*点」**乙\n', 0, null, true, true],
    ['BS-star-emphasis-mix', '甲**重点（a）***的*\n', 0, null, true, true],
    ['BS-adjacent-pairs', '**（甲）****（乙）**的\n', 0, null, true, true],
    ['BS-four-delims-tail', '**a（**b**）c**d**\n', 0, null, true, true],
    ['BS-astral-at-delim', '👍**「重点」**👍\n', 0, null, true, true],
    ['BS-image-alt', '![图**「重点」**注](a.png)\n', 1, 'both', false, true],
  ];

  it('matches the adversarial case table (ground truth from marked v18)', () => {
    for (const [name, md] of ADVERSARIAL) writeDoc(`wiki/cases/${name}.md`, md);
    const report = run();
    const byFile = new Map<string, Issue[]>();
    for (const iss of report.issues) {
      const list = byFile.get(iss.rel) ?? [];
      list.push(iss);
      byFile.set(iss.rel, list);
    }
    const mismatches: string[] = [];
    for (const [name, , count, sides] of ADVERSARIAL) {
      const got = byFile.get(`wiki/cases/${name}.md`) ?? [];
      if (got.length !== count) {
        mismatches.push(`${name}: 报 ${got.length} 条，期望 ${count}`);
        continue;
      }
      const gotSides = got.map((i) => i.side).join('+');
      if (sides !== null && gotSides !== sides) {
        mismatches.push(`${name}: sides=${gotSides}，期望 ${sides}`);
      }
    }
    assert.deepEqual(mismatches, [], `与案例表不一致：\n${mismatches.join('\n')}`);
  });
});
