// media.mjs — deterministic figure/asset handling for wiki-build.
//
// The rest of the pipeline assumes the source is text. For any source that
// carries figures (scanned textbooks, PPTX decks, papers) that assumption
// silently deletes the most important content. This script is the piece that
// makes media a first-class citizen: it collects extracted figures into a
// stable vault location, rewrites the source markdown to the ONE embed syntax
// the renderers actually resolve, and afterwards audits that every reference
// still points at a real file.
//
// Everything here is mechanical. Which figures matter, and what they mean, is
// the agent's job (see SKILL.md「含图源文件（图版）处理」).
//
// Usage:
//   node media.mjs collect <docling输出目录|md文件> <stem> --vault <dir>
//                           [--min-px N] [--force]
//   node media.mjs pages   <pdf> <stem> --vault <dir>
//                           [--dpi N] [--pages 1-20,42] [--force]
//   node media.mjs check   --vault <dir> [--json <out>] [--quiet]
//
// Output contract (same shape as prep.mjs):
//   stdout : human summary
//   stderr : one JSON metadata line
//   exit 0 : success (check: no dangling references)
//   exit 1 : usage error
//   exit 2 : unreadable input / vault not found / gate preconditions
//   exit 3 : gate failure (check: dangling image references)
//
// Outputs:
//   wiki/images/<stem>/NNN.ext       collected figures, numbered in document order
//   wiki/images/<stem>/page-NNN.png  whole-page renders (pages subcommand)
//   .molio/wiki-build/media-<stem>.md      source markdown, image refs canonicalized
//   .molio/wiki-build/figures-<stem>.json  figure manifest (caption / size / src)
//
// Generated figures use vault-relative ![[target]] embeds so moving a wiki
// page between folders does not break its images. The viewer also supports
// ordinary Markdown images, whose destinations are relative to the note.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveVault, buildDir } from './lib/cli.mjs';
import { IMAGE_EXT, ATTACHMENT_EXT, embedRe, codeIntervals, overlaps } from './lib/linktext.mjs';
import { collectMdPages, collectImages, collectAttachments, buildImageIndex, resolveAttachment } from './lib/vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Directory scanner cap (core/vault-prune.ts MAX_DIR_ENTRIES, raised 1000 →
// 5000 in 2e9af22f — update this mirror when that constant changes again).
// Exceeding it makes Molio prune the WHOLE directory from the file tree, so
// every figure in it disappears from the UI at once. Fail loudly instead.
const MAX_FIGURES_PER_DIR = 5000;

// Below this many pixels on the SHORT side a "figure" is layout-model noise —
// stray marks, rule lines, page furniture. Measured on a scanned textbook:
// real Venn diagrams came out 213x163..485x208, while junk came out 40x40.
const DEFAULT_MIN_PX = 64;

// Optional leading bracket: textbook captions are printed as "（图1.3-4）" or
// "(第3题)" as often as bare. Anchored at ^, so a caption mentioned mid-sentence
// ("可用 Venn图（图1.3-4）表示") is not mistaken for one.
const CAPTION_RE = /^\s*[（(]?\s*(?:图\s*[\d０-９一二三四五六七八九十]+(?:[.\-–—][\d０-９]+)*|表\s*[\d０-９一二三四五六七八九十]+|第\s*\d+\s*题|(?:fig(?:ure)?|table)\s*\d+)/i;

const MD_IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|(?:\\.|[^()\n\\]|\((?:\\.|[^()\\])*\))+?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/g;

function decodeImagePath(src) {
  let value = src.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  try { value = decodeURIComponent(value); } catch { /* literal percent */ }
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node media.mjs collect <docling输出目录|md文件> <stem> --vault <dir> [--min-px N] [--force]',
      '  node media.mjs pages   <pdf> <stem> --vault <dir> [--dpi N] [--pages 1-20,42] [--force]',
      '  node media.mjs check   --vault <dir> [--json <out>] [--quiet]',
      '',
      '  collect  收拢 docling --image-export-mode referenced 导出的图形 → wiki/images/<stem>/',
      '           并输出图片引用已规范化的 media-<stem>.md（给 prep.mjs 当源）',
      '  pages    整页渲染 PDF → wiki/images/<stem>/page-NNN.png（裁切失效时的兜底）',
      '  check    校验所有 ![[图片]] 引用存在（悬空 exit 3），并报告孤儿图',
      '',
      `  --min-px N   collect 的最小边长，低于此值的裁切视为噪点丢弃（默认 ${DEFAULT_MIN_PX}）`,
      '  --append     collect 追加模式：接续已有编号、追加到 media-<stem>.md',
      '               （长文档分块跑 docling 用：逐块 collect --append，编号自动接着排。',
      '                判断依据是 media-<stem>.md 是否已存在——追加到已有集合时，',
      '                第一块也要带 --append）',
      '  --force      collect：集合已由多块拼成时，不带 --append 必须加它才放行',
      '               （否则会清空既有图版并从 001 重编号，页面引用静默指向别的图）；',
      '               pages：覆盖已有整页图',
    ].join('\n') + '\n',
  );
}

function parseMediaArgs(argv) {
  const opts = { _: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--min-px') opts.minPx = parseInt(argv[++i], 10);
    else if (a === '--dpi') opts.dpi = parseInt(argv[++i], 10);
    else if (a === '--pages') opts.pages = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--append') opts.append = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

// ─── image dimensions (header parsing, no dependencies) ───

/**
 * Read {w,h} from an image header. Returns null for anything unrecognized —
 * callers treat null as "keep it", because dropping a figure we can't measure
 * is worse than keeping one we can't filter.
 */
export function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; // PNG IHDR
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }; // GIF logical screen
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk segments to the first SOFn frame header.
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
      const len = buf.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

// ─── collect ───

/**
 * Locate the markdown file inside a docling output dir (or accept an md path).
 *
 * The md sits at the top of `--output <dir>`, but a chunked run (one docling
 * invocation per --page-range, which is what long documents require) nests it
 * one level down, e.g. `.molio/docling/ch1/<name>.md`. So fall back to a
 * bounded recursive search — but REFUSE when several are found rather than
 * picking one, because silently collecting the wrong chunk's figures is worse
 * than an error.
 */
function findMarkdown(input) {
  const st = fs.statSync(input);
  if (st.isFile()) return path.resolve(input);

  const nested = [];
  const walk = (dir, depth) => {
    if (depth > 3 || nested.length > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else if (e.name.endsWith('.md')) nested.push(path.join(dir, e.name));
    }
  };
  walk(input, 0);
  if (nested.length === 1) return path.resolve(nested[0]);
  if (nested.length > 1) {
    throw new Error(
      `${input} 下有 ${nested.length} 份 docling 输出，无法确定收哪一份。\n` +
      '  分块跑时请对每一块单独 collect：\n' +
      nested.slice(0, 5).map((m) => `    media.mjs collect "${m}" <主名> [--append]`).join('\n'),
    );
  }
  return null;
}

/**
 * Resolve one docling image src to an absolute path.
 *
 * docling writes the path it saw at conversion time — on Windows that means
 * backslashes, and when it was invoked from the vault root the path is
 * CWD-relative rather than md-relative. Try every interpretation that can be
 * right, cheapest first, and give up rather than guess.
 */
function resolveSrc(src, mdDir, vault, searchRoots) {
  const norm = decodeImagePath(src).replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const candidates = [
    path.resolve(mdDir, norm),
    path.resolve(vault, norm),
  ];
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;

  // An explicit directory must resolve exactly; never replace it with another
  // chunk's identically named image. Bare names may use a unique tree match.
  if (norm.includes('/')) return null;
  const base = path.basename(norm).toLowerCase();
  const matches = new Set();
  for (const root of searchRoots) {
    walkFind(root, base, matches);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function walkFind(dir, baseLower, matches, depth = 0) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      walkFind(path.join(dir, e.name), baseLower, matches, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase() === baseLower) {
      matches.add(path.resolve(dir, e.name));
    }
  }
}

function cmdCollect(opts) {
  const [input, stem] = opts._.slice(1);
  if (!input || !stem) { usage(); process.exit(1); }
  validateStem(stem);
  const vault = resolveVault(opts);
  const minPx = Number.isInteger(opts.minPx) && opts.minPx >= 0 ? opts.minPx : DEFAULT_MIN_PX;

  let mdPath;
  try {
    mdPath = findMarkdown(input);
  } catch (e) {
    process.stderr.write(`[media] ERROR: cannot read input: ${e.message}\n`);
    process.exit(2);
  }
  if (!mdPath) {
    process.stderr.write(`[media] ERROR: no .md found under ${input}\n`);
    process.exit(2);
  }

  const mdDir = path.dirname(mdPath);
  const src = fs.readFileSync(mdPath, 'utf8');
  const searchRoots = [path.resolve(input), mdDir];
  const imgDir = path.join(vault, 'wiki', 'images', stem);

  const code = codeIntervals(src);
  const refs = [...src.matchAll(MD_IMG_RE)]
    .filter(m => !overlaps([m.index, m.index + m[0].length], code))
    .map((m) => ({ raw: m[0], alt: m[1], src: m[2].trim(), index: m.index }));
  if (refs.length === 0) {
    process.stderr.write(`[media] ERROR: ${path.basename(mdPath)} 里没有任何 markdown 图片引用。\n` +
      '  本命令消费的是 docling --image-export-mode referenced 的输出；\n' +
      '  如果源文件本身没有图，跳过 media.mjs 直接跑 prep.mjs。\n');
    process.exit(2);
  }

  const lines = src.split('\n');
  const lineStarts = [];
  { let acc = 0; for (const ln of lines) { lineStarts.push(acc); acc += ln.length + 1; } }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };

  const stemOut = path.join(buildDir(vault), `media-${stem}.md`);
  const figOut = path.join(buildDir(vault), `figures-${stem}.json`);
  fs.mkdirSync(buildDir(vault), { recursive: true });

  // Guard: a non-append run clears this stem's numbered images and restarts at
  // 001. That is correct when re-running ONE chunk, but it silently destroys an
  // accumulated multi-chunk collection — and the damage is invisible, because
  // every page reference still resolves, just to different pictures. Require an
  // explicit --force once the collection has been assembled from several chunks.
  if (!opts.append && !opts.force) {
    let priorChunks = 0;
    let priorFigures = 0;
    try {
      const prior = JSON.parse(fs.readFileSync(figOut, 'utf8'));
      priorFigures = (prior.figures ?? []).length;
      priorChunks = prior.chunks ?? (priorFigures ? 1 : 0);
    } catch { /* no prior collection for this stem — nothing to protect */ }
    if (priorChunks > 1) {
      process.stderr.write(
        `[media] ERROR: ${stem} 已有由 ${priorChunks} 块拼成的 ${priorFigures} 张图版，本次没带 --append。\n`
        + '  继续会清空既有图版并从 001 重新编号——页面里的图引用仍然解析得到，\n'
        + '  但指向的已经是别的图片，这种损坏不会报错。\n'
        + '  · 追加新块   → 加 --append\n'
        + '  · 整体重建   → 加 --force\n');
      process.exit(2);
    }
  }

  // Append mode: continue the existing numbering and append to the existing
  // markdown, so a long document can be run through docling in page-range
  // chunks (docling writes nothing until the whole run finishes, so one
  // interrupted 270-page run loses everything; 30-page chunks lose at most one
  // chunk). Without this, a second chunk would clear the first chunk's images
  // and restart at 001.
  let priorFigures = [];
  let priorMd = '';
  let priorChunks = 0;
  if (opts.append) {
    if (fs.existsSync(figOut)) {
      try {
        const prior = JSON.parse(fs.readFileSync(figOut, 'utf8'));
        priorFigures = prior.figures ?? [];
        priorChunks = prior.chunks ?? (priorFigures.length ? 1 : 0);
        if (!Array.isArray(priorFigures) || priorFigures.some((f, i) => f.id !== i + 1 ||
          typeof f.file !== 'string' || !f.file.startsWith(`wiki/images/${stem}/`))) {
          throw new Error('invalid figure manifest');
        }
      } catch {
        throw new Error(`Cannot append: invalid manifest ${figOut}; restore it before collecting more figures.`);
      }
    }
    if (fs.existsSync(stemOut) !== fs.existsSync(figOut)) {
      throw new Error('Cannot append: source markdown and figure manifest must both exist.');
    }
    if (fs.existsSync(stemOut)) priorMd = fs.readFileSync(stemOut, 'utf8');
  }
  const baseId = priorFigures.length;

  const figures = [];
  const dropped = [];
  const unresolved = [];
  const idOf = new Map(); // absSrc -> figure id, dedupes a figure referenced twice

  for (const ref of refs) {
    const abs = resolveSrc(ref.src, mdDir, vault, searchRoots);
    if (!abs) { unresolved.push(ref.src); continue; }
    if (idOf.has(abs)) continue; // same file referenced again — one copy, one id

    let buf;
    try { buf = fs.readFileSync(abs); } catch { unresolved.push(ref.src); continue; }
    const dim = imageSize(buf);
    if (dim && Math.min(dim.w, dim.h) < minPx) {
      dropped.push({ src: path.basename(abs), w: dim.w, h: dim.h });
      idOf.set(abs, 0); // sentinel: known, but dropped — remove the reference
      continue;
    }

    const id = baseId + figures.length + 1;
    idOf.set(abs, id);
    const ext = (path.extname(abs) || '.png').toLowerCase();

    // Caption: the nearest non-empty line before, else after. docling emits
    // CRLF and separates the caption from its figure with a blank line, so
    // probing only the immediately adjacent line misses every caption.
    const ln = lineOf(ref.index);
    const nearest = (from, step) => {
      for (let j = from; j >= 0 && j < lines.length; j += step) {
        const t = (lines[j] ?? '').trim();
        if (t) return t;
      }
      return null;
    };
    let caption = null;
    for (const candidate of [nearest(ln - 1, -1), nearest(ln + 1, 1)]) {
      if (candidate && CAPTION_RE.test(candidate)) { caption = candidate; break; }
    }
    // docling's alt text is usually the useless literal "Image"; a real alt
    // (when the producer supplied one) is the better caption.
    if (!caption && ref.alt && !/^image$/i.test(ref.alt.trim())) caption = ref.alt.trim();

    figures.push({
      id,
      file: `wiki/images/${stem}/${String(id).padStart(3, '0')}${ext}`,
      kind: 'figure',
      caption,
      src: path.relative(vault, abs).split(path.sep).join('/'),
      w: dim ? dim.w : null,
      h: dim ? dim.h : null,
    });
  }

  if (unresolved.length) {
    process.stderr.write(`[media] ERROR: ${unresolved.length} 个图片引用解析不到文件，先修 docling 输出再重跑：\n`);
    for (const u of unresolved.slice(0, 5)) process.stderr.write(`  ${u}\n`);
    process.exit(2);
  }
  const totalFigures = baseId + figures.length;
  if (opts.append) {
    for (const f of figures) {
      if (fs.existsSync(path.resolve(vault, f.file))) {
        throw new Error(`Cannot append: image already exists: ${f.file}`);
      }
    }
  }
  if (totalFigures > MAX_FIGURES_PER_DIR) {
    process.stderr.write(`[media] ERROR: 单个源抽出 ${totalFigures} 张图 > ${MAX_FIGURES_PER_DIR} 上限。\n` +
      `  Molio 每目录上限 ${MAX_FIGURES_PER_DIR}，超了整个目录会被文件树剪掉（图全部不可见）。\n` +
      `  请分片：media.mjs collect 时给不同的 <stem>，例如 ${stem}-1 / ${stem}-2。\n`);
    process.exit(2);
  }

  // Write images. Overwriting is the point (same input → same output), but a
  // stale run could have left higher-numbered files behind, so clear our own
  // numbered namespace first. Anything not matching our pattern is left alone.
  // Append mode keeps everything: the earlier chunks' files ARE the prefix.
  fs.mkdirSync(imgDir, { recursive: true });
  let stale = 0;
  if (!opts.append) {
    for (const f of fs.readdirSync(imgDir)) {
      if (/^\d{3,}\.[a-z0-9]+$/i.test(f)) { fs.rmSync(path.join(imgDir, f), { force: true }); stale++; }
    }
  }
  for (const f of figures) {
    fs.copyFileSync(path.resolve(vault, f.src), path.resolve(vault, f.file));
  }

  // Rewrite markdown to canonical embeds, with the caption moved BELOW the
  // image (the convention: image, then *caption*). Caption-only lines equal to
  // a figure caption are dropped afterwards, since we re-emit them ourselves.
  // Map by id, not by array index: ids are offset by baseId in append mode,
  // so `figures[id - 1]` would look up the wrong entry (or go out of bounds).
  const byId = new Map(figures.map((f) => [f.id, f]));
  const out = src.replace(MD_IMG_RE, (whole, _alt, s, offset) => {
    if (overlaps([offset, offset + whole.length], code)) return whole;
    const abs = resolveSrc(s.trim(), mdDir, vault, searchRoots);
    if (!abs) return whole;
    if (!idOf.has(abs)) return whole;         // unresolved — leave the text alone
    const id = idOf.get(abs);
    if (!id) return '';                        // dropped as noise — remove the ref
    const f = byId.get(id);
    if (!f) return whole;
    return `![[${f.file}]]${f.caption ? `\n\n*${f.caption}*` : ''}`;
  });

  const captionsOfFigures = new Set(figures.map((f) => f.caption).filter(Boolean));
  const kept = out.split('\n').filter((ln) => {
    const t = ln.trim();
    return !(CAPTION_RE.test(t) && captionsOfFigures.has(t));
  });

  // Normalize to LF: the input is CRLF (docling on Windows) and the caption
  // hoist above inserts bare \n, which would otherwise leave a mixed-ending
  // file. Harmless for prep.mjs (its verify strips whitespace), cleaner to read.
  const chunkMd = kept.join('\n').replace(/\r\n?/g, '\n');
  const allMd = priorMd ? `${priorMd.replace(/\s+$/, '')}\n\n${chunkMd}` : chunkMd;
  fs.writeFileSync(stemOut, allMd, 'utf8');
  fs.writeFileSync(figOut, JSON.stringify({
    source: path.resolve(input),
    markdown: mdPath,
    stem,
    imageDir: `wiki/images/${stem}`,
    minPx,
    chunks: priorChunks + 1,
    count: totalFigures,
    dropped: dropped.length,
    figures: [...priorFigures, ...figures],
    droppedList: dropped,
  }, null, 2), 'utf8');

  const rel = (p) => path.relative(vault, p).split(path.sep).join('/');
  const mode = opts.append ? `（追加，累计 ${totalFigures} 张）` : '';
  process.stdout.write([
    `[media] ${path.basename(mdPath)} → ${rel(imgDir)}`,
    `  收图: ${figures.length} 张${mode}（丢弃噪点 ${dropped.length} 张，阈值 ${minPx}px${stale ? `，清理旧文件 ${stale} 个` : ''}）`,
    `  有 caption: ${figures.filter((f) => f.caption).length} 张`,
    `  产物: ${rel(stemOut)} / ${rel(figOut)}`,
    `  下一步: node prep.mjs "${rel(stemOut)}" --vault .`,
  ].join('\n') + '\n');
  process.stderr.write(JSON.stringify({
    command: 'collect', stem, markdown: mdPath, imageDir: `wiki/images/${stem}`,
    append: !!opts.append, chunkFigures: figures.length, totalFigures,
    dropped: dropped.length, staleRemoved: stale, minPx,
    withCaption: figures.filter((f) => f.caption).length,
    outputs: { media: stemOut, figures: figOut },
    warnings: dropped.length
      ? [`丢弃 ${dropped.length} 张短边小于 ${minPx}px 的裁切（疑似噪点）：${dropped.slice(0, 5).map((d) => `${d.w}x${d.h}`).join(' ')}`]
      : [],
  }) + '\n');
  process.exit(0);
}

// ─── pages (whole-page fallback) ───

/**
 * Render PDF pages to PNG. Used when docling's layout model misses a figure
 * region that is fused into body text — on a scanned textbook the figure is
 * still recoverable as a page crop, and losing it silently is exactly the
 * failure this script exists to prevent.
 *
 * Shells out to PyMuPDF, which is already present as a docling dependency.
 */
function validateStem(stem) {
  if (!stem.trim() || stem === '.' || stem === '..' || /[\\/<>:"|?*\x00-\x1f\[\]#]/.test(stem) || /[. ]$/.test(stem)) {
    throw new Error('Collection name must be a single valid directory name.');
  }
}

function cmdPages(opts) {
  const [pdf, stem] = opts._.slice(1);
  if (!pdf || !stem) { usage(); process.exit(1); }
  validateStem(stem);
  const vault = resolveVault(opts);
  const dpi = Number.isInteger(opts.dpi) && opts.dpi > 0 ? opts.dpi : 150;
  if (!fs.existsSync(pdf)) {
    process.stderr.write(`[media] ERROR: not found: ${pdf}\n`);
    process.exit(2);
  }

  const imgDir = path.join(vault, 'wiki', 'images', stem);
  fs.mkdirSync(imgDir, { recursive: true });

  const helper = path.join(__dirname, 'lib', 'render-pages.py');
  if (!fs.existsSync(helper)) {
    process.stderr.write(`[media] ERROR: missing helper ${helper}\n`);
    process.exit(2);
  }

  const args = [helper, path.resolve(pdf), imgDir, String(dpi)];
  if (opts.pages) args.push(opts.pages);
  if (opts.force) args.push('--force');
  const r = spawnSync('python', args, { encoding: 'utf8' });
  if (r.error) {
    process.stderr.write(`[media] ERROR: cannot run python: ${r.error.message}\n` +
      '  整页兜底需要 PyMuPDF（pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple）。\n');
    process.exit(2);
  }
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    process.stderr.write(`[media] ERROR: page render failed (exit ${r.status})\n`);
    process.exit(2);
  }

  let files = [];
  try { files = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { files = []; }
  if (!Array.isArray(files)) files = [];
  process.stdout.write([
    `[media] ${path.basename(pdf)} → wiki/images/${stem}`,
    `  整页渲染: ${files.length} 页 @ ${dpi}dpi`,
    `  引用形如: ![[wiki/images/${stem}/page-042.png]]`,
  ].join('\n') + '\n');
  process.stderr.write(JSON.stringify({
    command: 'pages', stem, pdf: path.resolve(pdf), dpi,
    pages: files.length, imageDir: `wiki/images/${stem}`,
  }) + '\n');
  process.exit(0);
}

// ─── check ───

function cmdCheck(opts) {
  const vault = resolveVault(opts);
  if (!fs.existsSync(vault)) {
    process.stderr.write(`media: vault not found: ${vault}\n`);
    process.exit(2);
  }

  const pages = collectMdPages(vault);
  const images = collectImages(vault);
  const index = buildImageIndex(collectAttachments(vault));

  const missing = new Map();   // target -> {files:[{file,line}]}
  const ambiguous = new Map(); // target -> {hits, files:[...]}
  const referenced = new Set();
  const mdImageSites = [];     // standard-markdown images, see below
  let occurrences = 0;

  for (const rel of pages) {
    let content;
    try { content = fs.readFileSync(path.join(vault, 'wiki', rel), 'utf8'); } catch { continue; }
    // Inside a code fence or inline code, `![[图.png]]` is literal TEXT, not a
    // reference — e.g. this skill's own pages documenting the syntax, or a page
    // quoting a broken example. Same rule deadcheck and the graph apply to
    // [[wikilinks]]; a checker that forgot it would fail the build over its own
    // documentation.
    const code = codeIntervals(content);
    let lineStart = 0;
    content.split('\n').forEach((ln, i) => {
      for (const m of ln.matchAll(embedRe())) {
        const target = m[1].trim();
        // Only attachments are this script's business; [[页面]] is deadcheck's.
        if (!ATTACHMENT_EXT.test(target)) continue;
        if (overlaps([lineStart + m.index, lineStart + m.index + m[0].length], code)) continue;
        occurrences++;
        const r = resolveAttachment(target, index);
        if (r.status === 'ok') { referenced.add(r.resolved); continue; }
        const bucket = r.status === 'ambiguous' ? ambiguous : missing;
        if (!bucket.has(target)) bucket.set(target, { hits: r.hits, files: [] });
        bucket.get(target).files.push({ file: `wiki/${rel}`, line: i + 1 });
      }
      // Standard Markdown images resolve relative to this note, as in the UI.
      for (const mm of ln.matchAll(MD_IMG_RE)) {
        const src = decodeImagePath(mm[2]);
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(src)) continue;
        if (!IMAGE_EXT.test(src)) continue;
        if (overlaps([lineStart + mm.index, lineStart + mm.index + mm[0].length], code)) continue;
        const cleaned = src.replace(/\\/g, '/');
        const target = cleaned.startsWith('/') ? cleaned.replace(/^\/+/, '')
          : path.posix.join('wiki', path.posix.dirname(rel), cleaned);
        const r = resolveAttachment(target, index);
        if (r.status === 'ok') referenced.add(r.resolved);
        mdImageSites.push({ target: src, status: r.status, file: `wiki/${rel}`, line: i + 1 });
      }
      lineStart += ln.length + 1;
    });
  }

  const orphans = images.filter((rel) => !referenced.has(rel));
  const missingList = [...missing.entries()].map(([target, v]) => ({ target, ...v }));
  const ambiguousList = [...ambiguous.entries()].map(([target, v]) => ({ target, ...v }));

  const report = {
    ok: missingList.length === 0 && ambiguousList.length === 0 && mdImageSites.every(s => s.status === 'ok'),
    pages: pages.length,
    images: images.length,
    references: occurrences,
    danglingTargets: missingList.length,
    ambiguousTargets: ambiguousList.length,
    orphans: orphans.length,
    markdownImages: mdImageSites.length,
    markdownImagesUnresolved: mdImageSites.filter((s) => s.status !== 'ok').length,
    missing: missingList,
    ambiguous: ambiguousList,
    markdownImageSites: mdImageSites.slice(0, 200),
    orphanList: orphans.slice(0, 200),
  };

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
  }
  process.stderr.write(JSON.stringify({
    ok: report.ok, pages: pages.length, images: images.length,
    references: occurrences, dangling: missingList.length,
    ambiguous: ambiguousList.length, orphans: orphans.length,
    markdownImagesUnresolved: report.markdownImagesUnresolved,
  }) + '\n');

  const say = (s) => process.stdout.write(s + '\n');
  if (!opts.quiet) {
    if (report.ok) say(`media: OK — ${images.length} 张图, ${occurrences} 处引用, 0 悬空。`);
    else {
      say(`media: FAIL — ${missingList.length} 个悬空嵌入目标、${ambiguousList.length} 个歧义目标、${report.markdownImagesUnresolved} 处无效 Markdown 图片路径：`);
      for (const m of missingList.slice(0, 20)) {
        const locs = m.files.slice(0, 3).map((f) => `${f.file}:${f.line}`).join(' ');
        say(`  ![[${m.target}]] × ${m.files.length}  <- ${locs}`);
      }
      say('修法：把引用的路径改成实际文件（![[wiki/images/<stem>/NNN.png]]），或补上缺的图片文件。然后重跑 media check。');
    }
    if (ambiguousList.length) {
      say(`media: NOTE — ${ambiguousList.length} 个引用只给了裸文件名，vault 里有多张同名图，需写明完整路径：`);
      for (const a of ambiguousList.slice(0, 10)) say(`  ![[${a.target}]] — ${a.hits} 个同名文件`);
    }
    if (mdImageSites.length) {
      const bad = mdImageSites.filter((s) => s.status !== 'ok');
      say(`media: NOTE — ${mdImageSites.length} 处图片用的是标准 markdown 语法 ![](...)：`);
      say('  标准 Markdown 图片路径按笔记所在目录解析；生成页面建议使用完整 vault 路径的 ![[路径]]，便于移动页面。');
      // Show the sites that are ALSO unfindable first — those are broken in
      // Obsidian too, so they are the ones worth fixing now.
      const shown = bad.length ? bad : mdImageSites;
      if (bad.length) say(`  其中 ${bad.length} 处连文件都找不到（路径本身就是错的，在 Obsidian 里也是裂图）：`);
      for (const s of shown.slice(0, 5)) say(`    ${s.file}:${s.line}  ![](${s.target})`);
      if (shown.length > 5) say(`    … (+${shown.length - 5} more)`);
    }
    if (orphans.length) {
      say(`media: NOTE — ${orphans.length} 张图落在盘上但没有任何页面引用（孤儿图）：`);
      for (const o of orphans.slice(0, 10)) say(`  wiki/${o}`);
      if (orphans.length > 10) say(`  … (+${orphans.length - 10} more)`);
      say('不是门禁失败：图形可能留着待后续 ingest 引用；但成批孤儿通常说明建页时漏用了。');
    }
  }

  process.exit(report.ok ? 0 : 3);
}

// ─── main ───

function main() {
  const opts = parseMediaArgs(process.argv.slice(2));
  if (opts.help || !opts._.length) { usage(); process.exit(1); }
  const cmd = opts._[0];
  if (cmd === 'collect') return cmdCollect(opts);
  if (cmd === 'pages') return cmdPages(opts);
  if (cmd === 'check') return cmdCheck(opts);
  usage();
  process.exit(1);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[media] ERROR: ${e && e.message ? e.message : e}\n`);
  process.exit(4);
}
