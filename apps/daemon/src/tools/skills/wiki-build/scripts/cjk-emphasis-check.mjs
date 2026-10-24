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
// - ** 配对用非贪婪正则，拒绝跨段落配对（跨段一定不是同一强调）。段落分隔符
//   与产品渲染器 marked 同口径：一整行只含空格才算空行（Tab 行是缩进续行，
//   不断段），LF / CRLF 都接受；段落起止两端同源（PARA_SEP），不再一端用
//   字面 '\n\n'、另一端用宽容正则（那样在 CRLF 文件里两端会失衡）。
// - 残留判定用**段落级定界符栈模拟**（见下），每段只模拟一次。
//
// 残留判定：正则配对与 CommonMark 定界符栈的配对不是一回事——失效的闭合符会被
// 栈回收当开启符向后配对，失效的开启符也可能被当闭合符用，链式场景下整段仍能
// 全部配平（如 `**重点（关键点）**和**次重点**`、`**（括号）**和**（另一个）**`
// 渲染全部加粗、无字面 ** 残留）。逐对启发式豁免（只看后面有没有能闭合的 **）
// 无法同时覆盖开/闭两侧且不引入漏报（`甲**「重点」**乙**「丙」**丁` 后面同样有
// 能闭合的 **，但渲染仍残留）。因此对每个正则 pair 所在**段落**跑一次简化版
// 定界符栈模拟：每个 ** 按 flanking 判 canOpen/canClose，配不上的（既没当 opener
// 配出去也没当 closer 吃进来的）就是字面残留。正则 pair 的两个 ** 都被模拟配平
// 才豁免；任一残留才报。side（open/close/both）仍按 pair 边缘字符分类，用于提示
// 修法（哪一侧要补空格）。
//
// 已知盲区（均为保守漏报，有意为之；测试里以 BS- 前缀的案例逐条钉住）：
// - 配对内容含单个 * 不匹配（`**「甲*乙」**的` 找不到配对）；
// - **完全没有 closer 的孤立定界符不扫**（`**（甲）`、`甲**（乙）`、`**生态位\n\n
//   （萝卜坑）**的分配` 渲染确实是字面 **，但正则要求同段成对才扫得到；要覆盖需
//   独立的未配对检测，本版未做）；
// - **转义 / 三连及以上星号串 / 相邻四星**：`\**甲**的`、`***甲***的`、`**甲***的`、
//   甲****甲****乙 在渲染器里都留字面星号，本脚本一致跳过（保守，避免把粗斜体
//   和更长的星号串误判成加粗）；
// - **astral 字符（emoji 等代理对）紧贴定界符时与产品渲染器不一致**：marked 的
//   flanking 正则按 UTF-16 码元取相邻字符，代理对被劈成半个、既非标点也非文字，
//   于是 `👍**「重点」**👍`、`😀**「重点」**😀` 在 marked 里真渲染成字面 **，而本
//   脚本按码点取（CommonMark 正确口径）判为正常，漏报。BMP 符号（★、¥、→）两边
//   一致；emoji 出现在加粗**内部**时两边也一致（照报）。要跟随产品行为需按码元取
//   边缘字符，但那与规范相悖，取舍待定；
// - **图片 alt 文本内的 ** 会误报**：`![图**「重点」**注](a.png)` 的星号在 alt 里，
//   渲染器不进正文（无字面残留），但本脚本不做图片语法感知，照正文扫并报；
// - 配对超过 MAX_PAIR_LEN 跳过；
// - __ 下划线加粗不扫；
// - 闭合侧被转义时（`**甲\**的`）会报 close，但真实机制是 \ 吃掉闭合星号，
//   按提示改标点修不好，需删 \；
// - 共享 linktext.mjs 的 ``` 围栏闭合判定不区分 info string（多保护 = 漏报，
//   无害）；缩进代码块判定是启发式（空行后的 4 空格/Tab 缩进行），列表内
//   缩进内容会被一并保护；
// - 链接目的地 `](`…`)` 内的 ** 参与扫描（与正文的定界符栈同一片文本），极端
//   场景可能误报；CommonMark 链接解析优先于强调，此处不做链接感知（保守）。
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
// 段落分隔符：一整行只含空格（不含 Tab）——与产品渲染器 marked 的口径一致
// （marked 的 spaceLine 是 /^ +$/，Tab 行会被当成缩进续行、不分段）。CRLF 与 LF
// 都接受：\r\n\r\n、\n\n、\n \n、\r\n \r\n 都算，\n\t\n 不算。这条是段落边界
// 的**唯一**口径，起点与终点两端共用（曾经一端用字面 '\n\n' 另一端用 /\n\s*\n/，
// 在 CRLF 文件里两端彻底失衡）。
const PARA_SEP = /\r?\n *\r?\n/g;
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

// 段落区间：正文被 PARA_SEP 切成的各段 [start, end)。代码块/frontmatter 里的空行
// 不是段落边界（落在 skip 区间内的分隔符跳过）。全文件扫一次，起点与终点同源，
// 不依赖任何单点 lastIndexOf。
function paragraphIntervals(content, skip) {
  const bounds = [];
  let start = 0;
  PARA_SEP.lastIndex = 0;
  let m;
  while ((m = PARA_SEP.exec(content)) !== null) {
    const s = m.index;
    if (overlaps([s, s + m[0].length], skip)) continue; // 代码/frontmatter 内的空行
    bounds.push([start, s]);
    start = s + m[0].length;
  }
  bounds.push([start, content.length]);
  return bounds;
}

// ---- 段落级定界符栈模拟 ----
//
// CommonMark 对 ** 的规则（非 "_" 定界符没有左右字符类额外限制）：
//   canOpen  = left-flanking ：后非空白 且（后非标点 或 前是空白/标点）
//   canClose = right-flanking：前非空白 且（前非标点 或 后是空白/标点）
// 逐个扫段落内的 **：能闭合（栈非空且 canClose）就闭合栈顶；否则能开启就入栈；
// 都不行就是 dead（该 ** 必然字面残留）。扫完后栈里没配出去的 opener 同样残留。
// 与 marked 实测对齐（含链式重配对、emoji 码点边缘、行尾/文件边界）。

function simulateParagraphDelimiters(para, paraBase, isRealDelim) {
  // para: 段落文本；paraBase: 段落在全文的偏移；isRealDelim(absPos): 该位置的 **
  // 是否参与配对（不在 skip 区间、未转义、非更长星串）
  const dms = [];
  const re = /\*\*/g;
  let m;
  while ((m = re.exec(para)) !== null) {
    const abs = paraBase + m.index;
    if (!isRealDelim(abs)) continue;
    const before = charBefore(para, m.index);
    const after = charAt(para, m.index + 2);
    const bWs = isWsCh(before);
    const aWs = isWsCh(after);
    const bP = isPunctCh(before);
    const aP = isPunctCh(after);
    dms.push({
      abs,
      canOpen: !aWs && (!aP || bWs || bP),
      canClose: !bWs && (!bP || aWs || aP),
      matched: false,
    });
  }
  const stack = [];
  for (const dm of dms) {
    if (dm.canClose && stack.length > 0) {
      const opener = stack.pop();
      opener.matched = true;
      dm.matched = true;
    } else if (dm.canOpen) {
      stack.push(dm);
    }
    // 既不能闭合（或栈空）又不能开启：保持 unmatched —— 必然残留
  }
  return dms;
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
  const isRealDelim = (abs) =>
    !overlaps([abs, abs + 2], skip) &&
    !isEscaped(content, abs) &&
    content[abs - 1] !== '*' &&
    content[abs + 2] !== '*';

  // 段落切分：起点与终点同源（PARA_SEP），CRLF / 空格行 / Tab 行口径与 marked
  // 一致；代码块与 frontmatter 内的空行不算分隔符。
  const paras = paragraphIntervals(content, skip);
  const paraOf = (abs) => {
    // 二分找包含 abs 的段落；abs 落在分隔符上时归后一段（分隔符本身不含 **）
    let lo = 0;
    let hi = paras.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (paras[mid][0] <= abs) lo = mid;
      else hi = mid - 1;
    }
    return paras[lo];
  };
  // 每段只模拟一次（同一段里的多个 pair 共用结果）：曾经每个 pair 重扫整段，
  // 超大单段落（长表格、无空行的长列表）会退化成 O(pairs × 段长)。
  const simCache = new Map();
  const simFor = (para) => {
    const cached = simCache.get(para[0]);
    if (cached) return cached;
    const dms = simulateParagraphDelimiters(
      content.slice(para[0], para[1]),
      para[0],
      isRealDelim,
    );
    simCache.set(para[0], dms);
    return dms;
  };

  // inner 允许单个换行（CommonMark 允许加粗跨软换行），但不允许空行分隔：
  // 正则一旦跨空行配对（`甲**（乙丙\n\n而是**生态位…**` 会把上一段的 opener 和本段的
  // closer 配成一对），该 pair 被跳过后正则的 lastIndex 已越过本段的 opener，本段的
  // 真残留再也没机会被发现——整段漏报。CommonMark 本就不允许定界符跨段落配对，
  // 这里在配对层面直接拒绝，避免正则的贪婪消耗掩盖后续残留。
  const pairRe = /\*\*((?:(?!\r?\n *\r?\n)[^*])+?)\*\*/g;
  let m;
  while ((m = pairRe.exec(content)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps([start, end], skip)) continue;
    const inner = m[1];
    if (!inner.trim() || inner.length > MAX_PAIR_LEN) continue;
    if (isEscaped(content, start)) continue;
    // *** 粗斜体或更长星号串：保守跳过
    if (content[start - 1] === '*' || content[end] === '*') continue;

    // 残留判定：对该 pair 所在段落跑定界符栈模拟（段落由 PARA_SEP 切出，定界符
    // 不可跨段落配对，与正则的跨段拒绝口径一致）；模拟内的 ** 同样跳过
    // skip 区间/转义/更长星串。
    const dms = simFor(paraOf(start));
    // pair 的开启符（start）与闭合符（end-2）都在模拟里配平 → 整段无字面残留
    const openerDm = dms.find((d) => d.abs === start);
    const closerDm = dms.find((d) => d.abs === end - 2);
    const openerResidue = openerDm ? !openerDm.matched : true;
    const closerResidue = closerDm ? !closerDm.matched : true;
    if (!openerResidue && !closerResidue) continue;

    const prev = charBefore(content, start);
    const next = charAt(content, end);
    // side 分类（提示哪一侧要修，按几何 flanking 判）：
    // 开启符失效 = 内容以标点开篇、开启 ** 前紧贴文字；
    // 闭合符失效 = 内容以标点收尾、闭合 ** 后紧贴文字。
    const openFail = isPunctCh(charAt(inner, 0)) && isTextCh(prev);
    const closeFail = isPunctCh(charBefore(inner, inner.length)) && isTextCh(next);
    const side = openFail && closeFail ? 'both' : openFail ? 'open' : 'close';

    issues.push({
      rel: path.relative(vault, f).split(path.sep).join('/'),
      line: lineAt(content, start),
      side,
      pair: m[0].length > 60 ? `${m[0].slice(0, 57)}…` : m[0],
      context: snippet(content, start, end),
    });
  }
}

issues.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
console.log(JSON.stringify({ fileCount: files.length, issueCount: issues.length, issues }, null, 2));
