#!/usr/bin/env node
// deadcheck.mjs — deterministic dead-link audit for a wiki (the wiki-build
// completion gate). Zero LLM: scans every wiki/**/*.md, extracts [[wikilink]]
// targets, resolves them against existing page names, reports unresolved ones.
//
// Why a gate and not a warning: wiki-build's completion self-check must be
// mechanical. Dead links mean pages link to names that were never given a
// page (typically L3 long-tail entities skipped at placement time while the
// linking rule said "rather too many links than too few"). The two rules only
// stop contradicting each other when a build cannot finish with dead links.
//
// Usage:
//   node deadcheck.mjs --vault <dir> [--json <out.json>] [--quiet]
//
// Output contract (matches prep.mjs conventions):
//   stdout  : human summary (unless --quiet)
//   stderr  : one JSON metadata line
//   exit 0  : no dead links
//   exit 1  : dead links found (build must fix them before declaring done)
//   exit 2  : usage / vault not found
//
// Resolution rules (mirrors daemon routes/graph.ts so what passes here also
// renders as a real node in the graph view):
//   - [[李白]]            → any page whose basename (no .md) is 李白
//   - [[entities/李白]]   → path-suffix match wiki/entities/李白.md, else leaf
//   - [[李白|诗仙]]       → target is the part before |
//   - case-insensitive; spaces/dashes/underscores ignored (en kebab-case)
//   - non-md targets (images etc.) are skipped

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node deadcheck.mjs --vault <dir> [--json <out.json>] [--quiet]',
      '',
      'Exit codes: 0 no dead links, 1 dead links found, 2 usage error.',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv) {
  const opts = { vault: '.', json: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { usage(); process.exit(2); }
  }
  return opts;
}

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|docx?|xlsx?|pptx?|zip)$/i;

function normalizeName(name) {
  return name.replace(/[\s_\-]+/g, '').toLowerCase();
}

/** Collect all md pages under wiki/; returns [{rel, base}] (base = basename without .md). */
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

/** Extract wikilink targets from markdown content (same shape as graph.ts). */
function extractTargets(content) {
  const out = [];
  const re = /\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (raw) out.push(raw);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const vault = path.resolve(opts.vault);
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    process.stderr.write(`deadcheck: vault not found: ${vault}\n`);
    process.exit(2);
  }

  const pages = collectPages(vault);
  if (pages.length === 0) {
    process.stderr.write(JSON.stringify({ ok: true, pages: 0, deadTargets: 0, occurrences: 0 }) + '\n');
    if (!opts.quiet) process.stdout.write('deadcheck: no wiki pages found, nothing to check.\n');
    process.exit(0);
  }

  // Resolution indexes (mirrors graph.ts resolveLink).
  const byBase = new Map();        // normalized base → [rel]
  const byRelPath = new Set();     // normalized relative path without .md
  for (const p of pages) {
    const nb = normalizeName(p.base);
    if (!byBase.has(nb)) byBase.set(nb, []);
    byBase.get(nb).push(p.rel);
    byRelPath.add(normalizeName(p.rel.replace(/\.md$/i, '')));
  }

  function resolves(raw) {
    let clean = raw.replace(/\.md$/i, '').trim();
    if (SKIP_EXT.test(raw)) return true; // non-md attachment, not a dead link
    const nFull = normalizeName(clean);
    if (byRelPath.has(nFull)) return true;
    const leaf = clean.includes('/') ? clean.split('/').pop() : clean;
    return byBase.has(normalizeName(leaf ?? clean));
  }

  // dead target → occurrences [{file, line}]
  const dead = new Map();
  let occurrences = 0;
  for (const p of pages) {
    const abs = path.join(vault, 'wiki', p.rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const lines = content.split('\n');
    lines.forEach((ln, i) => {
      for (const target of extractTargets(ln)) {
        if (resolves(target)) continue;
        occurrences++;
        const key = target.toLowerCase();
        if (!dead.has(key)) dead.set(key, { target, files: [] });
        dead.get(key).files.push({ file: `wiki/${p.rel}`, line: i + 1 });
      }
    });
  }

  const deadList = [...dead.values()].sort((a, b) => b.files.length - a.files.length);
  const report = {
    ok: deadList.length === 0,
    pages: pages.length,
    deadTargets: deadList.length,
    occurrences,
    dead: deadList,
  };

  if (opts.json) {
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
  }
  process.stderr.write(JSON.stringify({ ok: report.ok, pages: pages.length, deadTargets: deadList.length, occurrences }) + '\n');

  if (!opts.quiet) {
    if (report.ok) {
      process.stdout.write(`deadcheck: OK — ${pages.length} pages, 0 dead links.\n`);
    } else {
      process.stdout.write(`deadcheck: FAIL — ${deadList.length} dead target(s), ${occurrences} occurrence(s):\n`);
      for (const d of deadList) {
        const locs = d.files.slice(0, 3).map(f => `${f.file}:${f.line}`).join(' ');
        const more = d.files.length > 3 ? ` … (+${d.files.length - 3})` : '';
        process.stdout.write(`  [[${d.target}]] × ${d.files.length}  <- ${locs}${more}\n`);
      }
      process.stdout.write('\nFix before declaring build complete: create (stub) pages for these targets, or rewrite the links to an existing page / plain text. Then re-run deadcheck.\n');
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
