#!/usr/bin/env node
// linkpass.mjs — deterministic missed-link repair for a wiki. Zero LLM.
//
// Complements deadcheck.mjs: deadcheck guarantees every [[link]] has a page;
// linkpass guarantees every page that SHOULD be linked IS linked. Writing
// style decisions ("did the model remember to type [[ ]] in this sentence")
// must not determine graph structure — linking becomes a mechanical pass:
//
//   For every wiki page, wrap the FIRST body occurrence of every other page
//   name (and its aliases) in [[wikilinks]].
//
// One edge per pair is all the graph needs; first-occurrence keeps prose
// readable. Idempotent — existing [[...]] regions are protected, re-runs are
// no-ops.
//
// Protected regions (never touched, so quotes stay verbatim for
// `prep.mjs verify` and code stays intact):
//   - YAML frontmatter
//   - fenced code blocks ``` and inline code `...`
//   - existing [[wikilinks]] and [markdown](links)
//   - quoted text 「」『』“” (citations from source material)
//
// Usage:
//   node linkpass.mjs --vault <dir> [--aliases <json>] [--dry-run]
//
// aliases json: { "alias": "CanonicalPageName", ... } — canonical must be an
// existing wiki page base name, otherwise the entry is skipped with a
// warning. Ambiguous aliases (one surface form → several people) must NOT be
// in the file; curate at merge time (L2a).
//
// Output contract (matches prep.mjs conventions):
//   stdout  : human summary
//   stderr  : one JSON metadata line
//   exit 0  : success (with or without edits), exit 2 usage error.

import fs from 'node:fs';
import path from 'node:path';

// Navigational pages are link targets of last resort, not prose vocabulary —
// never auto-link mentions of them, and don't rewrite these files.
const NAV_BASES = new Set(['index', 'log', 'hot']);

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node linkpass.mjs --vault <dir> [--aliases <json>] [--batches <dir>] [--dry-run]',
      '',
      'Wraps the first body occurrence of every wiki page name (and alias) in',
      '[[wikilinks]] on every page. Idempotent. Exit 0 success, 2 usage error.',
      '--batches: read aliases from batch TSV files (别名列), replaces --aliases.',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv) {
  const opts = { vault: '.', aliases: null, batches: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--aliases') opts.aliases = argv[++i];
    else if (a === '--batches') opts.batches = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { usage(); process.exit(2); }
  }
  return opts;
}

function collectPages(vault) {
  const wikiDir = path.join(vault, 'wiki');
  const pages = [];
  if (!fs.existsSync(wikiDir)) return pages;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rp);
      else if (e.isFile() && e.name.endsWith('.md')) {
        pages.push({ rel: rp, base: e.name.replace(/\.md$/i, '') });
      }
    }
  };
  walk(wikiDir, '');
  return pages;
}

/** End offset of YAML frontmatter block, or 0 if none. */
function frontmatterEnd(content) {
  if (!content.startsWith('---')) return 0;
  const m = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/);
  return m ? m[0].length : 0;
}

/** Interval helpers. */
function overlaps(a, list) {
  for (const [s, e] of list) if (a[0] < e && a[1] > s) return true;
  return false;
}

/**
 * Collect protected intervals for one file: frontmatter, code fences, inline
 * code, existing wikilinks, markdown links, and quoted spans.
 */
function protectedIntervals(content, fmEnd) {
  const prot = [[0, fmEnd]];

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

  // Existing wikilinks.
  for (const im of content.matchAll(/\[\[[^\]]*\]\]/g)) prot.push([im.index, im.index + im[0].length]);

  // Markdown links [text](url).
  for (const im of content.matchAll(/\[[^\]\n]*\]\([^)\n]*\)/g)) prot.push([im.index, im.index + im[0].length]);

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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const vault = path.resolve(opts.vault);
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    process.stderr.write(`linkpass: vault not found: ${vault}\n`);
    process.exit(2);
  }

  const pages = collectPages(vault);
  if (pages.length === 0) {
    process.stderr.write(JSON.stringify({ ok: true, editedFiles: 0, addedLinks: 0 }) + '\n');
    process.stdout.write('linkpass: no wiki pages found.\n');
    process.exit(0);
  }

  // Canonical names = page base names minus navigational pages.
  const canonicals = new Set();
  for (const p of pages) {
    if (NAV_BASES.has(p.base.toLowerCase())) continue;
    canonicals.add(p.base);
  }

  // Alias map: alias → canonical (validated against canonicals).
  const aliasMap = new Map();
  const skippedAliases = [];

  // Source 1: --aliases JSON file (legacy format)
  if (opts.aliases) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.resolve(opts.aliases), 'utf-8'));
    } catch (err) {
      process.stderr.write(`linkpass: cannot read aliases file: ${err.message}\n`);
      process.exit(2);
    }
    for (const [alias, canonical] of Object.entries(raw)) {
      if (typeof alias !== 'string' || typeof canonical !== 'string' || !alias || !canonical) continue;
      if (!canonicals.has(canonical)) { skippedAliases.push(alias); continue; }
      aliasMap.set(alias, canonical);
    }
  }

  // Source 2: --batches TSV files (new format: 别名列 per row)
  if (opts.batches && fs.existsSync(path.resolve(opts.batches))) {
    const batchesDir = path.resolve(opts.batches);
    for (const f of fs.readdirSync(batchesDir).filter(f => f.endsWith('.tsv'))) {
      for (const raw of fs.readFileSync(path.join(batchesDir, f), 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const cols = line.split('\t');
        if (cols.length < 5) continue;
        const canonical = cols[0].trim();
        const aliasCol = cols[2].trim(); // 别名: X/Y/Z
        if (!canonicals.has(canonical)) continue;
        const aliasStr = aliasCol.replace(/^别名[：:]\s*/, '');
        if (!aliasStr) continue;
        for (const alias of aliasStr.split(/[/、,，]/)) {
          const a = alias.trim();
          if (!a || a === canonical) continue;
          if (aliasMap.has(a)) continue; // 先到先得，不覆盖
          aliasMap.set(a, canonical);
        }
      }
    }
  }

  // Page's own identity: base name + aliases pointing at it — never self-link.
  function selfSet(base) {
    const s = new Set([base]);
    for (const [alias, canonical] of aliasMap) if (canonical === base) s.add(alias);
    return s;
  }

  // Names to link, longest first so 贾宝玉 wins over 宝玉 at the same spot.
  const names = [
    ...[...canonicals].map(n => ({ surface: n, target: n })),
    ...[...aliasMap.entries()].map(([a, c]) => ({ surface: a, target: c })),
  ].sort((a, b) => b.surface.length - a.surface.length);

  let editedFiles = 0;
  let addedLinks = 0;
  const perFile = [];

  for (const p of pages) {
    const baseLower = p.base.toLowerCase();
    if (NAV_BASES.has(baseLower)) continue;               // don't rewrite nav pages
    if (p.rel.startsWith('meta/') || p.rel.startsWith('meta\\')) continue; // lint reports etc.

    const abs = path.join(vault, 'wiki', p.rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }

    const fmEnd = frontmatterEnd(content);
    const prot = protectedIntervals(content, fmEnd);
    const self = selfSet(p.base);

    // Protect the first H1 heading line — it is the page title, never prose.
    const h1 = content.slice(fmEnd).match(/^#[ \t]+[^\n]*/m);
    if (h1) prot.push([fmEnd + h1.index, fmEnd + h1.index + h1[0].length]);

    // All occurrences of all names in the body (computed once, original
    // coordinates) — the algorithm decides on each name's TRUE first
    // occurrence only, which is what makes the pass idempotent.
    // Self-name occurrences are recorded too (isSelf): they are never wrapped,
    // but they must shield their substrings — 元妃 inside the page's own name
    // 元妃省亲 must not be linked.
    const occ = []; // {start, end, surface, target, isSelf}
    const findOcc = (surface, target, isSelf) => {
      let pos = fmEnd;
      while (pos < content.length) {
        const idx = content.indexOf(surface, pos);
        if (idx === -1) break;
        occ.push({ start: idx, end: idx + surface.length, surface, target, isSelf });
        pos = idx + 1;
      }
    };
    for (const { surface, target } of names) {
      const isSelf = self.has(surface) || surface.toLowerCase() === baseLower;
      findOcc(surface, target, isSelf);
    }
    occ.sort((a, b) => a.start - b.start || b.surface.length - a.surface.length);

    const containingInterval = (s, e) => prot.find(([ps, pe]) => ps <= s && e <= pe);
    const inLongerName = (o) => occ.some(
      q => q.surface.length > o.surface.length && q.start <= o.start && o.end <= q.end,
    );

    const edits = [];
    for (const { surface, target } of names) {
      if (self.has(surface)) continue;
      if (surface.toLowerCase() === baseLower) continue;
      const first = occ.find(o => o.surface === surface);
      if (!first) continue;                        // never mentioned → nothing to do
      if (containingInterval(first.start, first.end)) continue; // inside link/quote/H1:
      //   covered or untouchable — and unchanged by this pass, so idempotent.
      if (inLongerName(first)) continue;           // part of a longer name (e.g. 元妃 in
      //   元妃省亲, 宝玉 in 贾宝玉) — the longer name's own handling governs.
      const replacement = surface === target ? `[[${target}]]` : `[[${target}|${surface}]]`;
      edits.push({ start: first.start, end: first.end, replacement });
    }

    if (edits.length === 0) continue;

    edits.sort((a, b) => b.start - a.start);
    let next = content;
    for (const e of edits) next = next.slice(0, e.start) + e.replacement + next.slice(e.end);

    if (!opts.dryRun) fs.writeFileSync(abs, next);
    editedFiles++;
    addedLinks += edits.length;
    perFile.push({ file: `wiki/${p.rel}`, added: edits.length });
  }

  const meta = { ok: true, dryRun: opts.dryRun, editedFiles, addedLinks, skippedAliases };
  process.stderr.write(JSON.stringify(meta) + '\n');

  process.stdout.write(
    `linkpass${opts.dryRun ? ' (dry-run)' : ''}: +${addedLinks} link(s) across ${editedFiles} file(s)` +
    (skippedAliases.length ? `; skipped ${skippedAliases.length} alias(es) without a page` : '') + '\n',
  );
  for (const f of perFile.slice(0, 30)) process.stdout.write(`  ${f.file}: +${f.added}\n`);
  if (perFile.length > 30) process.stdout.write(`  … (+${perFile.length - 30} more files)\n`);
  if (skippedAliases.length) {
    process.stdout.write(`  skipped aliases (no page): ${skippedAliases.slice(0, 10).join(', ')}${skippedAliases.length > 10 ? ' …' : ''}\n`);
  }
  process.exit(0);
}

main();
