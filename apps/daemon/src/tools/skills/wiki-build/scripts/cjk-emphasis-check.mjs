#!/usr/bin/env node
// cjk-emphasis-check.mjs — CJK 加粗失效扫描（soft 报告，非门禁）。零 LLM，确定性。
// 用法: node cjk-emphasis-check.mjs [--vault <dir>]
//
// 背景：CommonMark flanking 规则下，`**` 定界符一侧贴标点、另一侧贴文字（汉字）
// 时不生效——
//   - 闭合符失效：`**生态位（萝卜坑）**的分配`（闭合 ** 前是标点 ）、后是文字 的）
//   - 开启符失效：`甲**「重点」**乙`（开启 ** 后是标点 「、前是文字 甲）
// 两种都把 ** 按字面渲染。中文没有空格，这是 CJK 写作最常踩的 markdown 坑
//（英文里两侧通常有空格，几乎不会触发）。
//
// 口径（以 linktext.mjs 与 deadcheck/orphan-audit 同口径为基础，本脚本另有增补）：
// - 跳过 frontmatter（容忍 BOM，与产品渲染器 renderer-impl.ts 一致）、```
//   围栏、行内代码；本脚本增补：~~~ 围栏、缩进代码块、跨行/等长反引号代码
//   span（CommonMark 口径）。增补只在本脚本内生效，不改共享库。
// - 标点判定 = Unicode P + S 两个 general category（CommonMark 0.31 口径，
//   与 marked 源码一致）——¥、emoji、→、★ 等符号都算标点。
// - 边缘字符按码点取（emoji 是代理对，按 UTF-16 码元取会判错）。
// - 跳过 \ 转义（定界符前奇数个连续反斜杠）与 *** 粗斜体/更长星串。
// - ** 配对用非贪婪正则，拒绝跨空行配对（跨段一定不是同一强调）。
// - 并列加粗豁免：闭合失效的配对，若同段落后面还有可闭合的 **（CommonMark
//   定界符栈会让失败的闭合符重新当开启符向后配对，实际渲染为嵌套加粗、无
//   字面 ** 残留），则不报闭合侧——如 `**重点（关键点）**和**次重点**` 渲染
//   全部加粗，不是问题。
//
// 已知盲区（均为保守漏报，有意为之）：
// - 配对内容含单个 * 不匹配（`**「甲*乙」**的` 找不到配对）；
// - 配对超过 MAX_PAIR_LEN 跳过；四星连排等更长星串相邻跳过；
// - __ 下划线加粗不扫；
// - 闭合侧被转义时（`**甲\**的`）会报 close，但真实机制是 \ 吃掉闭合星号，
//   按提示改标点修不好，需删 \；
// - 共享 linktext.mjs 的 ``` 围栏闭合判定不区分 info string（多保护 = 漏报，
//   无害）；缩进代码块判定是启发式（空行后的 4 空格/Tab 缩进行），列表内
//   缩进内容会被一并保护。
//
// 输出契约（同 orphan-audit.mjs）：stdout JSON，恒 exit 0（报告型脚本）——
// vault 不存在、wiki/ 不是目录、单文件读失败都返回空/部分结果，不崩。

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, usage } from './lib/cli.mjs';
import { frontmatterEnd, codeIntervals, overlaps } from './lib/linktext.mjs';

// CommonMark "punctuation" = Unicode P + S 两类（spec 0.31；marked 同口径）。
// S 类涵盖 $+<=>^`|~ 等 ASCII 符号以及 ¥、emoji、→、★ 等非 ASCII 符号。
const PUNCT = /[\p{P}\p{S}]/u;
const WS = /\s/;
const BLANK_LINE = /\n\s*\n/;
const MAX_PAIR_LEN = 2000;

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  usage('cjk-emphasis-check', ['[--vault <dir>]']);
  process.exit(0);
}
const vault = resolveVault(opts);
const wiki = path.join(vault, 'wiki');

// ---- 按码点取字符（emoji 等 astral 字符是代理对，按码元取会拿到半个） ----

function charBefore(s, i) {
  if (i <= 0) return '';
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

function charAt(s, i) {
  if (i >= s.length) return '';
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i];
}

// 行首/行尾/文件边界视同空白（CommonMark flanking 定义）
const isWsCh = (ch) => ch === '' || WS.test(ch);
const isPunctCh = (ch) => ch !== '' && PUNCT.test(ch);
const isTextCh = (ch) => ch !== '' && !WS.test(ch) && !PUNCT.test(ch);

// ---- 本脚本增补的跳过区间（不动共享库，口径只在此处生效） ----

function forEachLine(content, cb) {
  let start = 0;
  while (start <= content.length) {
    let nl = content.indexOf('\n', start);
    if (nl === -1) nl = content.length;
    cb(content.slice(start, nl), start, nl);
    if (nl === content.length) break;
    start = nl + 1;
  }
}

// ~~~ 围栏（CommonMark：闭合围栏长度 ≥ 开启且不能带 info string；未闭合护到 EOF）
function tildeFenceIntervals(content) {
  const prot = [];
  let openStart = -1;
  let openLen = 0;
  forEachLine(content, (line, s, e) => {
    if (openStart === -1) {
      const m = /^ {0,3}(~{3,})/.exec(line);
      if (m) { openStart = s; openLen = m[1].length; }
    } else {
      const m = /^ {0,3}(~{3,})[ \t]*$/.exec(line);
      if (m && m[1].length >= openLen) { prot.push([openStart, e]); openStart = -1; }
    }
  });
  if (openStart !== -1) prot.push([openStart, content.length]);
  return prot;
}

// 缩进代码块：空行/文件头之后的 4 空格或 Tab 缩进行（缩进代码不能打断段落，
// 所以紧跟非空行的缩进行仍是正文，不保护）；段内允许夹空行。
function indentedCodeIntervals(content) {
  const prot = [];
  let runStart = -1;
  let lastEnd = -1;
  let prevBlankOrBof = true;
  forEachLine(content, (line, s, e) => {
    const indented = /^(?: {4}|\t)/.test(line);
    const blank = line.trim() === '';
    if (indented && (prevBlankOrBof || runStart !== -1)) {
      if (runStart === -1) runStart = s;
      lastEnd = e;
    } else if (!blank && runStart !== -1) {
      prot.push([runStart, lastEnd]);
      runStart = -1;
    }
    prevBlankOrBof = blank;
  });
  if (runStart !== -1) prot.push([runStart, lastEnd]);
  return prot;
}

// 行内代码 span：等长反引号串配对，允许跨行（CommonMark 口径）；配不上对的
// 反引号串是字面文本，不保护。
function codeSpanIntervals(content) {
  const prot = [];
  const runs = [];
  for (const m of content.matchAll(/`+/g)) runs.push([m.index, m.index + m[0].length]);
  let i = 0;
  while (i < runs.length) {
    const [s, e] = runs[i];
    const len = e - s;
    let j = i + 1;
    while (j < runs.length && runs[j][1] - runs[j][0] !== len) j++;
    if (j < runs.length) {
      prot.push([s, runs[j][1]]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return prot;
}

// frontmatter 区间：容忍 BOM（产品渲染器同样容忍）；无 frontmatter 返回 [0, 0]
function frontmatterInterval(content) {
  const bom = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const end = frontmatterEnd(content.slice(bom));
  return [0, end > 0 ? bom + end : 0];
}

// ---- 扫描辅助 ----

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 不可读/不是目录：软报告，跳过
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function lineAt(content, offset) {
  let n = 1;
  for (let i = 0; i < offset; i++) if (content[i] === '\n') n++;
  return n;
}

function snippet(content, start, end) {
  const from = Math.max(0, start - 20);
  const to = Math.min(content.length, end + 20);
  return content.slice(from, to).replace(/\r?\n/g, '⏎');
}

// 定界符前奇数个连续反斜杠 = 被转义
function isEscaped(content, pos) {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && content[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

// 该位置的 ** 能否当闭合符（right-flanking）：前面不是空白，且（前面不是标点
// 或后面是空白/标点）
function canCloseAt(content, k) {
  const prev = charBefore(content, k);
  const next = charAt(content, k + 2);
  return !isWsCh(prev) && (!isPunctCh(prev) || isWsCh(next) || isPunctCh(next));
}

// 并列加粗豁免：pair 的闭合符失效后，CommonMark 定界符栈会把它当开启符继续
// 向后配对——同段落后面只要还有一个能闭合的 **，整段实际渲染为嵌套加粗，
// 没有字面 ** 残留，不算失效（如 `**重点（关键点）**和**次重点**`）。
function hasLaterCloser(content, from, skip) {
  const tail = content.slice(from);
  const blank = BLANK_LINE.exec(tail);
  const paraEnd = blank ? from + blank.index : content.length;
  const re = /\*\*/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(content)) !== null && m.index < paraEnd) {
    const k = m.index;
    if (content[k - 1] === '*' || content[k + 2] === '*') continue; // 更长星串保守不算
    if (isEscaped(content, k)) continue;
    if (overlaps([k, k + 2], skip)) continue; // 代码/ frontmatter 里的 ** 不参与配对
    if (canCloseAt(content, k)) return true;
  }
  return false;
}

let wikiStat = null;
try {
  wikiStat = fs.statSync(wiki);
} catch {
  wikiStat = null; // vault/wiki 不存在：空报告
}
const files = wikiStat?.isDirectory() ? walk(wiki) : [];
const issues = [];

for (const f of files) {
  let content;
  try {
    content = fs.readFileSync(f, 'utf8');
  } catch {
    continue; // 单文件读失败：跳过，不影响其余文件
  }
  const skip = [
    frontmatterInterval(content),
    ...codeIntervals(content),
    ...tildeFenceIntervals(content),
    ...indentedCodeIntervals(content),
    ...codeSpanIntervals(content),
  ];
  const pairRe = /\*\*([^*]+?)\*\*/g;
  let m;
  while ((m = pairRe.exec(content)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps([start, end], skip)) continue;
    const inner = m[1];
    if (!inner.trim() || inner.length > MAX_PAIR_LEN || BLANK_LINE.test(inner)) continue;
    if (isEscaped(content, start)) continue;
    // *** 粗斜体或更长星号串：保守跳过
    if (content[start - 1] === '*' || content[end] === '*') continue;

    const prev = charBefore(content, start);
    const next = charAt(content, end);
    // 开启符失效：加粗内容以标点开篇，开启 ** 前紧贴文字
    const openFail = isPunctCh(charAt(inner, 0)) && isTextCh(prev);
    // 闭合符失效：加粗内容以标点收尾，闭合 ** 后紧贴文字
    let closeFail = isPunctCh(charBefore(inner, inner.length)) && isTextCh(next);
    // 并列加粗豁免：同段落后面有可闭合的 ** 会与失败的闭合符重配对
    if (closeFail && hasLaterCloser(content, end, skip)) closeFail = false;
    if (!openFail && !closeFail) continue;

    issues.push({
      rel: path.relative(vault, f).split(path.sep).join('/'),
      line: lineAt(content, start),
      side: openFail && closeFail ? 'both' : openFail ? 'open' : 'close',
      pair: m[0].length > 60 ? `${m[0].slice(0, 57)}…` : m[0],
      context: snippet(content, start, end),
    });
  }
}

issues.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
console.log(JSON.stringify({ fileCount: files.length, issueCount: issues.length, issues }, null, 2));
