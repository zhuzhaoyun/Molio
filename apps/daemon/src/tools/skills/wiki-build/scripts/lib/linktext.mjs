// lib/linktext.mjs — shared wikilink-text helpers for linkpass.mjs and
// deadcheck.mjs. Single home so the two never drift apart on what counts as
// "protected" or "residue".

// Legacy double-wrap residue from pre-idempotency linkpass versions:
// [[T|Y]] immediately followed by Y]] — can only be damage (renders broken),
// so collapsing it to plain Y is mechanical and safe.
// Factory, not a shared instance: a /g regex carries mutable lastIndex, and
// sharing one across files breaks silently the day someone calls .exec/.test.
export const residueRe = () => /\[\[[^\]|]+\|([^\]]+)\]\]\1\]\]/g;

// ─── 图片/附件嵌入 ───
//
// `![[路径]]` 是嵌入（渲染成图），`[[路径]]` 是链接（在图谱里会变成 dead 节点，
// 因为 graph.ts 的 resolveLink 硬拒附件扩展名）。两者只差一个前导 `!`，
// 所以解析、校验、保护必须共用同一套定义，否则三个脚本迟早各判各的。

/** 图片扩展名。这些是媒体，不是页面。 */
export const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|tiff?)$/i;

/** 非页面附件（图片 + 文档 + 压缩包）。deadcheck 用它跳过「不是死链」的目标。 */
export const ATTACHMENT_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|tiff?|pdf|docx?|xlsx?|pptx?|zip)$/i;

/**
 * `![[目标]]` 嵌入。捕获组 1 = 目标路径（去掉 `|尺寸/别名` 之后的部分）。
 * 工厂函数而非共享实例：/g 正则带可变 lastIndex，跨文件共享会静默出错。
 */
export const embedRe = () => /!\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g;

/** End offset of YAML frontmatter block, or 0 if none. */
export function frontmatterEnd(content) {
  if (!content.startsWith('---')) return 0;
  const m = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  return m ? m[0].length : 0;
}

/** Interval overlap test: is [a0, a1) intersecting any [s, e) in list? */
export function overlaps(a, list) {
  for (const [s, e] of list) if (a[0] < e && a[1] > s) return true;
  return false;
}

/**
 * Code-only intervals: fenced blocks + inline code. Inside these, [[...]] is
 * literal text — it does not render as a link, so it is neither wrap-able
 * (linkpass) nor dead-checkable (deadcheck).
 */
export function codeIntervals(content) {
  const prot = [];

  // Fenced code blocks: line starting with ``` until closing fence.
  const fenceRe = /^[ \t]*```[^\n]*$/gm;
  let open = -1;
  let m;
  while ((m = fenceRe.exec(content)) !== null) {
    if (open === -1) open = m.index;
    else { prot.push([open, m.index + m[0].length]); open = -1; }
  }
  if (open !== -1) prot.push([open, content.length]);

  // Inline code (single line spans).
  for (const im of content.matchAll(/`[^`\n]+`/g)) prot.push([im.index, im.index + im[0].length]);

  return prot;
}

/**
 * Collect protected intervals for one file: frontmatter, code, quoted spans,
 * and (unless links:false) existing wikilinks + markdown links.
 *
 * links:false is for the RESIDUE scan: the residue pattern starts with a
 * wikilink by definition ([[T|Y]]Y]]), so treating links as protected would
 * hide every residue — while frontmatter/code/quoted citations must still
 * stay byte-identical (prep.mjs verify depends on it).
 */
export function protectedIntervals(content, fmEnd, { links = true } = {}) {
  const prot = [[0, fmEnd], ...codeIntervals(content)];

  if (links) {
    // Existing wikilinks. `!?` includes the embed marker: covering only the
    // inner [[...]] would leave the leading `!` exposed, so a page whose name
    // happens to start there could be wrapped INSIDE an embed and corrupt it
    // (`![[甲]][[乙]]`). Protecting the whole token is the only safe span.
    for (const im of content.matchAll(/!?\[\[[^\]]*\]\]/g)) prot.push([im.index, im.index + im[0].length]);
    // Markdown links [text](url) — same `!?` reasoning for images ![alt](url).
    for (const im of content.matchAll(/!?\[[^\]\n]*\]\([^)\n]*\)/g)) prot.push([im.index, im.index + im[0].length]);
  }

  // Quoted spans — citations must stay byte-identical for prep.mjs verify.
  // Cap each span at 500 chars to avoid runaway pairing on unbalanced quotes.
  const QUOTE_PAIRS = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’']];
  for (const [o, c] of QUOTE_PAIRS) {
    let i = 0;
    while (i < content.length) {
      const s = content.indexOf(o, i);
      if (s === -1) break;
      let e = content.indexOf(c, s + o.length);
      if (e === -1 || e - s > 500) { i = s + o.length; continue; }
      e += c.length;
      prot.push([s, e]);
      i = e;
    }
  }

  prot.sort((a, b) => a[0] - b[0]);
  return prot;
}
