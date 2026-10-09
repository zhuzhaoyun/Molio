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
// Word boundaries: a name is only linked when it stands on its own. An
// occurrence embedded in a larger Latin/ASCII word (`abi` in "Capabilities",
// `OWL` in "KNOWLEDGE", `RDF` in "RDFox") is skipped, so the pass never
// mangles ordinary words into links. CJK names have no word boundaries, so
// longer CJK names are linked freely (flush CJK text is normal) — but a short
// CJK surface (≤3 chars) glued between Han characters on both sides is more
// often a substring of an unrelated longer word (心理 in 核心理念, 网络 in
// 神经网络) than a real mention, so it is skipped: a missed link is
// recoverable, a wrong link mangles prose. Page names get no exemption —
// [[网络]] resolves fine when 网络.md exists, so an embedded wrap of a
// short-named page is SILENT damage that deadcheck cannot see.
// --no-cjk-guard restores the old link-freely behavior.
//
// Boundary checks look THROUGH adjacent links at their display text
// ([[T|Y]] reads as Y, [[T]] as T). Wrapping a neighbor inserts brackets —
// if the guards read raw neighbor characters, that insertion would flip
// their verdict on the next run, and the pass would add one more link per
// run instead of converging in a single pass.
//
// Name collisions: if an alias string is also the name of an existing page,
// the page wins (a link displays as the page it resolves to — deadcheck
// agrees) and the alias is reported in `collidedAliases`. Without this, both
// entries wrap the same occurrence and stack into fresh [[T|Y]]Y]] residue.
//
// Legacy residue: pre-idempotency linkpass versions left double-wrap residue
// behind ([[T|Y]]Y]]). The pattern can only be damage, so it is mechanically
// collapsed to plain Y before the link pass — which also stops residue
// self-copying into new pages. Cleanup honors the protected regions below.
//
// Protected regions (never touched, so quotes stay verbatim for
// `prep.mjs verify` and code stays intact):
//   - YAML frontmatter
//   - fenced code blocks ``` and inline code `...`
//   - existing [[wikilinks]] and [markdown](links)
//   - quoted text 「」『』“” (citations from source material)
//
// Usage:
//   node linkpass.mjs --vault <dir> [--aliases <json>] [--batches <dir>] [--dry-run] [--no-cjk-guard]
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
import { cleanAliasToken } from './lib/cli.mjs';
import { residueRe, frontmatterEnd, overlaps, protectedIntervals } from './lib/linktext.mjs';

// Navigational pages are link targets of last resort, not prose vocabulary —
// never auto-link mentions of them, and don't rewrite these files.
const NAV_BASES = new Set(['index', 'log', 'hot']);

// A "word" character for boundary purposes = ASCII letter/digit/underscore.
// Only Latin/ASCII runs get this boundary protection; CJK embedding is
// handled separately by the cjkEmbedded guard in the per-page loop below.
const LATIN_WORD = /[A-Za-z0-9_]/;

// CJK embedded-word guard: Han script test + the max surface length the guard
// applies to (counted in code points, not UTF-16 units, so ext-B names keep
// their protection). Longer aliases are distinctive enough to link freely.
const HAN = /\p{Script=Han}/u;
const CJK_GUARD_MAX = 3;

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node linkpass.mjs --vault <dir> [--aliases <json>] [--batches <dir>] [--dry-run] [--no-cjk-guard]',
      '',
      'Wraps the first body occurrence of every wiki page name (and alias) in',
      '[[wikilinks]] on every page. Idempotent. Exit 0 success, 2 usage error.',
      '--batches: read aliases from batch TSV files (别名列), replaces --aliases.',
      '--no-cjk-guard: link short CJK names even when embedded between Han chars',
      '  (legacy behavior — default skips them: 宁可漏链，不可错链).',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv) {
  const opts = { vault: '.', aliases: null, batches: null, dryRun: false, cjkGuard: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--aliases') opts.aliases = argv[++i];
    else if (a === '--batches') opts.batches = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-cjk-guard') opts.cjkGuard = false;
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
          // 清洗：剔 无/-/单字/自名/链接语法（与 curate 预填同规则，防 agent 手填脏）
          const a = cleanAliasToken(alias, canonical);
          if (!a) continue;
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

  // Name/alias collisions: an alias string that is also an existing page name
  // (nav pages included — [[hot]] resolves to hot.md too) would push a SECOND
  // edit at the same coordinates and stack into fresh [[T|Y]]Y]] residue.
  // The page wins (a link displays as the page it resolves to — deadcheck
  // agrees); the alias is reported, not silently dropped.
  const pageNameLower = new Set(pages.map(p => p.base.toLowerCase()));
  const collidedAliases = [];
  // Names to link, longest first so 贾宝玉 wins over 宝玉 at the same spot
  // (lengths in code points — same unit as the CJK guard's threshold).
  const names = [
    ...[...canonicals].map(n => ({ surface: n, target: n })),
    ...[...aliasMap.entries()].flatMap(([a, c]) => {
      if (pageNameLower.has(a.toLowerCase())) { collidedAliases.push(a); return []; }
      return [{ surface: a, target: c }];
    }),
  ].sort((a, b) => [...b.surface].length - [...a.surface].length);

  let editedFiles = 0;
  let cleanedFiles = 0;
  let addedLinks = 0;
  let residueFixed = 0;
  let residueTruncated = 0;
  const perFile = [];

  // Vault-side opt-in for the CJK guard's one remaining blind spot: a page name
  // that is a PREFIX of a longer word. The both-sides-Han test only fires when
  // Han is on BOTH sides, so `第六章 平面向量` / `精神，对数学` slip through and
  // wrap [[平面]]向量 / [[对数]]学. A general fix needs a lexicon of Chinese
  // function words; a particle list mis-fires on good links ([[平面]]内的点).
  // So the vault lists the pairs it has actually been bitten by:
  //   wiki/.linkpass-compounds.json   →   { "对数": ["学"], "平面": ["向"] }
  // Extend it whenever a `[[X]]Y` mis-split is spotted (the收尾 scan in the
  // wiki-build SKILL documents how to find them).
  const compoundGuard = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(vault, 'wiki', '.linkpass-compounds.json'), 'utf-8'));
    for (const [name, follow] of Object.entries(raw)) {
      if (Array.isArray(follow) && follow.length) compoundGuard.set(name, new Set(follow));
    }
  } catch { /* no vault-side compound list — guard behaves exactly as before */ }

  for (const p of pages) {
    const baseLower = p.base.toLowerCase();
    if (NAV_BASES.has(baseLower)) continue;               // don't rewrite nav pages
    if (p.rel.startsWith('meta/') || p.rel.startsWith('meta\\')) continue; // lint reports etc.

    const abs = path.join(vault, 'wiki', p.rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }

    // Collapse legacy [[T|Y]]Y]] residue before anything else computes wrap
    // coordinates — the freed alias text then goes through the normal guards.
    // Hard-protected regions (frontmatter / fences / inline code / citations)
    // stay byte-identical; links:false because the residue pattern itself
    // starts with a wikilink. A match touching ANY protected byte is skipped
    // whole rather than edited across a boundary. Nested residue
    // ([[甲|乙]][[甲|乙]]乙]]]]) exposes the next layer only after the outer
    // one collapses, so loop until stable — prot is recomputed each round.
    // The 20-round cap bounds pathological input; residueCount counts LAYERS,
    // not spots (a 2-layer nest counts 2), and a file that still has hits on
    // the last round may have deeper layers left — reported, not hidden.
    let residueCount = 0;
    let residueMaybeLeft = false;
    for (let round = 0; round < 20; round++) {
      const hardProt = protectedIntervals(content, frontmatterEnd(content), { links: false });
      const hits = [...content.matchAll(residueRe())].filter(
        m => !overlaps([m.index, m.index + m[0].length], hardProt),
      );
      if (!hits.length) { residueMaybeLeft = false; break; }
      for (const m of hits.sort((a, b) => b.index - a.index)) {
        content = content.slice(0, m.index) + m[1] + content.slice(m.index + m[0].length);
      }
      residueCount += hits.length;
      residueMaybeLeft = round === 19;
    }
    // Round 20 may have peeled the LAST layer — peek once (look only) so an
    // exactly-20 nest doesn't cry wolf.
    if (residueMaybeLeft) {
      const hardProt = protectedIntervals(content, frontmatterEnd(content), { links: false });
      residueMaybeLeft = [...content.matchAll(residueRe())].some(
        m => !overlaps([m.index, m.index + m[0].length], hardProt),
      );
    }

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
    // Link-transparent neighbors: an occurrence flush against an existing
    // link must see the link's DISPLAY text ([[T|Y]] reads as Y), not the raw
    // brackets. Wrapping a neighbor inserts [[…]] — if the guards below read
    // raw characters, that insertion would flip their verdict on the next
    // run, and the pass would add one more link per run instead of
    // converging in a single pass.
    const prevDisplayChar = new Map(); // link end offset → last display char
    const nextDisplayChar = new Map(); // link start offset → first display char
    const rememberLink = (index, len, display) => {
      const chars = [...display.trim()];
      if (!chars.length) return;
      prevDisplayChar.set(index + len, chars[chars.length - 1]);
      nextDisplayChar.set(index, chars[0]);
    };
    for (const lm of content.matchAll(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g)) {
      rememberLink(lm.index, lm[0].length, lm[2] ?? lm[1] ?? '');
    }
    for (const lm of content.matchAll(/\[([^\]\n]*)\]\([^)\n]*\)/g)) {
      rememberLink(lm.index, lm[0].length, lm[1] ?? '');
    }
    // Inline emphasis/code markers are as transparent as link syntax. A guard
    // reading `**对数学` must see the character before 对 (in 精神对数学), not the
    // `*`: reading the raw marker makes the CJK guard judge a word-initial page
    // name to be a standalone mention and wrap it, producing `[[对数]]学` out of
    // the word 对数学. Judging the rendered text is also what keeps the verdict
    // stable across runs, since the markers do not move when links are inserted.
    const MARKUP = /[*_~`]/;
    const prevChar = (s) => {
      if (prevDisplayChar.has(s)) return prevDisplayChar.get(s);
      let i = s;
      while (i > 0 && MARKUP.test(content[i - 1])) i -= 1;
      if (prevDisplayChar.has(i)) return prevDisplayChar.get(i);
      if (i <= 0) return '';
      const cp = content.codePointAt(i - 1);
      // low surrogate → the real code point (ext-B Han etc.) starts one unit earlier
      if (cp >= 0xdc00 && cp <= 0xdfff && i > 1) return String.fromCodePoint(content.codePointAt(i - 2));
      return String.fromCodePoint(cp);
    };
    const nextChar = (e) => {
      if (nextDisplayChar.has(e)) return nextDisplayChar.get(e);
      let i = e;
      while (i < content.length && MARKUP.test(content[i])) i += 1;
      if (nextDisplayChar.has(i)) return nextDisplayChar.get(i);
      return i < content.length ? String.fromCodePoint(content.codePointAt(i)) : '';
    };

    // Reject occurrences embedded in a larger Latin/ASCII word — `abi` inside
    // "Capabilities", `OWL` inside "KNOWLEDGE", `RDF` inside "RDFox". Without
    // this, indexOf substring-matching mangles ordinary words into links.
    const boundaryOK = (s, e) => !LATIN_WORD.test(prevChar(s)) && !LATIN_WORD.test(nextChar(e));
    // Reject SHORT CJK surfaces glued between Han characters on both sides —
    // usually a substring of an unrelated longer word (心理 in 核心理念,
    // 网络 in 神经网络). Applies to page names AND aliases alike: "is this a
    // word fragment" has nothing to do with the name's origin, and an
    // embedded wrap of a page name is deadcheck-invisible. Skip: 宁可漏链，
    // 不可错链. The occurrence is left unchanged, so the pass stays
    // idempotent.
    const cjkEmbedded = (s, e, surface) => {
      if ([...surface].length > CJK_GUARD_MAX || !HAN.test(surface)) return false;
      const next = nextChar(e);
      // A name that is a PREFIX of a longer word: the both-sides-Han test below
      // misses it whenever the left neighbour is a space or punctuation, so
      // 第六章 [[平面]]向量 and ，[[对数]]学 got wrapped out of 平面向量 / 对数学.
      // The general fix would need a lexicon of Chinese function words, and a
      // particle list mis-fires on perfectly good noun+particle links
      // ([[平面]]内的点). So the vault names its own offenders instead.
      const follows = compoundGuard.get(surface);
      if (follows && follows.has(next)) return true;
      return HAN.test(prevChar(s)) && HAN.test(next);
    };

    const edits = [];
    // One edit per span. Unreachable by construction (surfaces in `names` are
    // unique and a span's text determines the surface) — kept as a guard so
    // any FUTURE name source fails soft instead of stacking [[T|Y]]Y]].
    const takenSpans = new Set();
    for (const { surface, target } of names) {
      if (self.has(surface)) continue;
      if (surface.toLowerCase() === baseLower) continue;
      const first = occ.find(o => o.surface === surface);
      if (!first) continue;                        // never mentioned → nothing to do
      if (containingInterval(first.start, first.end)) continue; // inside link/quote/H1:
      //   covered or untouchable — and unchanged by this pass, so idempotent.
      if (!boundaryOK(first.start, first.end)) continue; // embedded in a larger word —
      //   leave it alone (and unchanged by this pass, so idempotent).
      if (opts.cjkGuard && cjkEmbedded(first.start, first.end, surface)) continue;
      //   ^ embedded inside a CJK word — same deal: left unchanged, idempotent.
      if (inLongerName(first)) continue;           // part of a longer name (e.g. 元妃 in
      //   元妃省亲, 宝玉 in 贾宝玉) — the longer name's own handling governs.
      const spanKey = `${first.start}:${first.end}`;
      if (takenSpans.has(spanKey)) continue;
      takenSpans.add(spanKey);
      const replacement = surface === target ? `[[${target}]]` : `[[${target}|${surface}]]`;
      edits.push({ start: first.start, end: first.end, replacement });
    }

    if (edits.length === 0 && residueCount === 0) continue;

    edits.sort((a, b) => b.start - a.start);
    let next = content;
    for (const e of edits) next = next.slice(0, e.start) + e.replacement + next.slice(e.end);

    if (!opts.dryRun) fs.writeFileSync(abs, next);
    if (edits.length) editedFiles++;
    if (residueCount) cleanedFiles++;
    if (residueMaybeLeft) residueTruncated++;
    addedLinks += edits.length;
    residueFixed += residueCount;
    perFile.push({ file: `wiki/${p.rel}`, added: edits.length, residue: residueCount });
  }

  const meta = {
    ok: true, dryRun: opts.dryRun,
    editedFiles, cleanedFiles, addedLinks, residueFixed, residueTruncated,
    skippedAliases, collidedAliases,
  };
  process.stderr.write(JSON.stringify(meta) + '\n');

  process.stdout.write(
    `linkpass${opts.dryRun ? ' (dry-run)' : ''}: +${addedLinks} link(s) across ${editedFiles} file(s)` +
    (residueFixed ? `; ${opts.dryRun ? 'would clean' : 'cleaned'} ${residueFixed} legacy [[T|Y]]Y]] residue(s) in ${cleanedFiles} file(s)` : '') +
    (residueTruncated ? `; WARNING ${residueTruncated} file(s) hit the 20-round residue cap — deeper layers may remain, re-run to continue` : '') +
    (collidedAliases.length ? `; ${collidedAliases.length} alias(es) collide with page names (page wins): ${collidedAliases.slice(0, 10).join(', ')}` : '') +
    (skippedAliases.length ? `; skipped ${skippedAliases.length} alias(es) without a page` : '') + '\n',
  );
  for (const f of perFile.slice(0, 30)) {
    process.stdout.write(`  ${f.file}: +${f.added}${f.residue ? `, cleaned ${f.residue} residue` : ''}\n`);
  }
  if (perFile.length > 30) process.stdout.write(`  … (+${perFile.length - 30} more files)\n`);
  if (skippedAliases.length) {
    process.stdout.write(`  skipped aliases (no page): ${skippedAliases.slice(0, 10).join(', ')}${skippedAliases.length > 10 ? ' …' : ''}\n`);
  }
  process.exit(0);
}

main();
