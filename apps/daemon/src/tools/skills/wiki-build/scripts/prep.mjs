#!/usr/bin/env node
// prep.js — deterministic preprocessing for wiki-build on huge source files.
//
// Turns "a 7-million-char novel the agent can't read" into deterministic
// artifacts the agent CAN work with: a line-normalized UTF-8 transcode,
// a structural segment index (chapters/headings or fixed chunks), processing
// ranges (~100k chars each → L1 subagent batches), and an entity frequency
// census computed in ONE pass per pattern (replacing O(candidates × filesize)
// grep loops). All mechanics, zero LLM judgment — domain knowledge lives in
// profiles/*.json (novel vs default), chosen by the agent or auto-detected.
//
// Usage:
//   node prep.mjs <source> [--vault <dir>] [--profile <name|path>]
//                          [--charset <enc>] [--top <N>] [--force]
//   node prep.mjs status <source> [--vault <dir>]
//   node prep.mjs verify <wikiPage> <sourceTxt>
//
// Output contract:
//   prepare → stdout: human summary; stderr: one JSON metadata line; exit 0
//   status  → stdout: JSON (ranges/candidates completion); exit 0
//   verify  → stdout: JSON (quote spot-check result); exit 0
// Exit codes: 1 usage, 2 read/decode failure, 3 profile failure, 4 internal.
//
// Outputs (into <vault>/.molio/wiki-build/):
//   transcode-<stem>.txt   UTF-8, line-normalized copy (grep/Read target)
//   segments-<stem>.json   segment + range index (stable line addresses)
//   census-<stem>.json     entity frequency rows + alias hints (regenerated)
//   candidates-<stem>.md   checklist seeded from census   (kept if exists)
//   progress-<stem>.md     range checklist + tier TODOs   (kept if exists)
//
// candidates/progress are NEVER overwritten without --force — that is what
// makes a multi-hour build resumable after a crash.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAndDecode } from './lib/encoding.mjs';
import { normalizeLines } from './lib/normalize.mjs';
import { segmentLines, fixedChunks, groupRanges } from './lib/segment.mjs';
import { runCensus } from './lib/census.mjs';

// ESM has no __dirname; the CLI resolves profiles/ relative to itself.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

// ─── args ───

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node prep.mjs <source> [--vault <dir>] [--profile <name|path>] [--charset <enc>] [--top <N>] [--force]',
      '  node prep.mjs status <source> [--vault <dir>]',
      '  node prep.mjs verify <wikiPage> <sourceTxt>',
      '',
      'Profiles: default (markdown/notes), novel (章节结构 + 中文姓名普查). Auto-detected if omitted.',
    ].join('\n') + '\n',
  );
}

function parseArgs(argv) {
  const opts = { _: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--charset') opts.charset = argv[++i];
    else if (a === '--top') opts.top = parseInt(argv[++i], 10);
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

// ─── profile loading ───

function profilesDir() {
  return path.join(__dirname, 'profiles');
}

function loadProfile(nameOrPath) {
  const file = /[\\/]/.test(nameOrPath) || nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(profilesDir(), `${nameOrPath}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw Object.assign(new Error(`profile not found: ${file}`), { exitCode: 3 });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`profile is not valid JSON (${file}): ${e.message}`), { exitCode: 3 });
  }
}

/**
 * Auto-select a profile from its `detect` signal. Two counts, take the max:
 *   1. line-anchored: `detect.regex` tested against the first lines — works
 *      for normally line-broken sources
 *   2. inline: global occurrences of the profile's first `inlineSplitCores`
 *      pattern — catches single-line dumps where chapter markers sit mid-line
 *      (a line-anchored scan sees exactly one "line" and would undercount)
 * Only a hint to the agent — an explicit --profile always wins.
 */
function autoSelectProfile(text) {
  const headText = text.slice(0, 500000);
  const headLines = headText.split('\n').slice(0, 500);
  const candidates = fs.readdirSync(profilesDir()).filter((f) => f.endsWith('.json'));
  for (const file of candidates.sort()) {
    let profile;
    try {
      profile = JSON.parse(fs.readFileSync(path.join(profilesDir(), file), 'utf8'));
    } catch {
      continue;
    }
    if (!profile.detect || !profile.detect.regex) continue;

    let lineMatches = 0;
    try {
      const re = new RegExp(profile.detect.regex);
      lineMatches = headLines.filter((l) => re.test(l.trim())).length;
    } catch { /* broken detect regex — fall through to inline count */ }

    let inlineMatches = 0;
    const core = (profile.inlineSplitCores || [])[0];
    if (core) {
      try {
        inlineMatches = (headText.match(new RegExp(core, 'g')) || []).length;
      } catch { /* broken core — ignore */ }
    }

    const matches = Math.max(lineMatches, inlineMatches);
    if (matches >= (profile.detect.minMatches ?? 3)) {
      return { profile, name: profile.name || path.basename(file, '.json'), matches, chosenBy: 'auto' };
    }
  }
  return { profile: loadProfile('default'), name: 'default', matches: 0, chosenBy: 'auto-fallback' };
}

// ─── naming / paths ───

function stemOf(sourcePath) {
  const base = path.basename(sourcePath).replace(/\.[^.]+$/, '');
  return base.replace(/[^\w一-龥.-]/g, '_') || 'source';
}

function outDirFor(vault) {
  return path.join(vault, '.molio', 'wiki-build');
}

// ─── prepare ───

function cmdPrepare(opts) {
  const source = opts._[0];
  if (!source) { usage(); process.exit(1); }
  const vault = path.resolve(opts.vault || process.cwd());
  const warnings = [];

  let buffer;
  try {
    const stat = fs.statSync(source);
    if (stat.size > MAX_SOURCE_BYTES) {
      throw new Error(`source too large: ${(stat.size / 1024 / 1024).toFixed(0)}MB > 500MB cap`);
    }
    buffer = fs.readFileSync(source);
  } catch (e) {
    process.stderr.write(`[prep] ERROR: cannot read source: ${e.message}\n`);
    process.exit(2);
  }
  if (source.includes('.molio')) {
    warnings.push('source 位于 .molio 下——通常应对原始源文件运行 prep.js，而非对 transcode 副本重复运行');
  }

  // Encoding
  let decoded;
  try {
    decoded = detectAndDecode(buffer, opts.charset);
  } catch (e) {
    process.stderr.write(`[prep] ERROR: ${e.message}\n`);
    process.exit(2);
  }
  if (decoded.hint) warnings.push(decoded.hint);

  // Profile
  let profile, profileName, chosenBy, detectMatches;
  if (opts.profile) {
    try {
      profile = loadProfile(opts.profile);
    } catch (e) {
      process.stderr.write(`[prep] ERROR: ${e.message}\n`);
      process.exit(e.exitCode || 3);
    }
    profileName = profile.name || opts.profile;
    chosenBy = 'explicit';
    detectMatches = null;
  } else {
    const sel = autoSelectProfile(decoded.text);
    profile = sel.profile;
    profileName = sel.name;
    chosenBy = sel.chosenBy;
    detectMatches = sel.matches;
    if (chosenBy === 'auto' && profileName !== 'default') {
      warnings.push(`自动检测到 ${detectMatches} 处章节结构，选用 ${profileName} profile（可用 --profile 覆盖）`);
    }
  }

  // Normalize
  const lines = normalizeLines(decoded.text, {
    maxLineChars: profile.maxLineChars,
    inlineSplitCores: profile.inlineSplitCores,
    titleMarkerCore: (profile.inlineSplitCores || [])[0],
  });

  // Segment
  let { segments, segmented } = segmentLines(lines, profile);
  if (!segmented) {
    segments = fixedChunks(lines, profile.chunkChars ?? 80000);
  }
  const ranges = groupRanges(segments, profile.rangeChars ?? 100000);

  // Census (alias scanning happens inside runCensus — collapse uses it)
  const topN = Number.isInteger(opts.top) && opts.top > 0 ? opts.top : (profile.censusTopN ?? 300);
  const joined = lines.join('\n');
  let census = { rows: [], excluded: 0, aliasHints: [] };
  if ((profile.entityPatterns || []).length) {
    census = runCensus(joined, profile, topN);
  }
  const aliasHints = census.aliasHints || [];

  // Write outputs
  const stem = stemOf(source);
  const outDir = outDirFor(vault);
  fs.mkdirSync(outDir, { recursive: true });

  const files = {
    transcode: path.join(outDir, `transcode-${stem}.txt`),
    segments: path.join(outDir, `segments-${stem}.json`),
    census: path.join(outDir, `census-${stem}.json`),
    candidates: path.join(outDir, `candidates-${stem}.md`),
    progress: path.join(outDir, `progress-${stem}.md`),
  };

  fs.writeFileSync(files.transcode, joined + '\n', 'utf8');
  fs.writeFileSync(files.segments, JSON.stringify({
    source: path.resolve(source),
    sourceName: path.basename(source),
    generatedBy: 'wiki-build/prep.js',
    profile: profileName,
    encoding: decoded.encoding,
    chars: decoded.text.length,
    lineCount: lines.length,
    segmented,
    segments,
    ranges,
  }, null, 2), 'utf8');
  fs.writeFileSync(files.census, JSON.stringify({
    source: path.basename(source),
    profile: profileName,
    topN,
    excludedCommonWords: census.excluded,
    rows: census.rows,
    aliasHints,
  }, null, 2), 'utf8');

  // candidates + progress: resume-safe — never clobber an in-flight checklist
  let candidatesWritten = false;
  if ((opts.force || !fs.existsSync(files.candidates)) && census.rows.length) {
    const rows = census.rows.map((r) => `- [ ] ${r.surface} ${r.count}`).join('\n');
    fs.writeFileSync(files.candidates, [
      `# 候选实体：${path.basename(source)}`,
      '',
      `> prep.js 按 ${profileName} profile 普查生成（top ${topN}，频率降序）。`,
      '> 建页后打勾（- [ ] → - [x]）。建页粒度见 wiki-build SKILL「建页粒度」。',
      '> 噪音项直接打勾并注明跳过即可；census-<stem>.json 里有完整数据可复查。',
      '',
      rows,
      '',
    ].join('\n'), 'utf8');
    candidatesWritten = true;
  }

  let progressWritten = false;
  if (opts.force || !fs.existsSync(files.progress)) {
    const rangeRows = ranges.map((r) =>
      `- [ ] R${String(r.i).padStart(3, '0')} ${r.label}（L${r.startLine}-L${r.endLine}, ${(r.chars / 10000).toFixed(1)} 万字）`,
    ).join('\n');
    fs.writeFileSync(files.progress, [
      `# 构建进度：${path.basename(source)}`,
      '',
      `> 源文件：${path.resolve(source)}`,
      `> 编码：${decoded.encoding} | 字符：${decoded.text.length} | 规范化行数：${lines.length}`,
      `> profile：${profileName} | 分段：${segmented ? '结构分段' : '固定切块'} ${segments.length} 段 → ${ranges.length} 个处理范围`,
      '',
      '## L1 范围清单（digest 完成即打勾）',
      '',
      rangeRows,
      '',
      '## L2 候选清单',
      '',
      `见 candidates-${stem}.md（页面建成即打勾）。`,
      '',
      '## L3 长尾（可选，允许遗留）',
      '',
      '- [ ] 低频候选批量处理（可留给后续 ingest/query 按需补）',
      '',
    ].join('\n'), 'utf8');
    progressWritten = true;
  }

  // Summary (stdout) + metadata (stderr)
  const out = [
    `[prep] ${path.basename(source)} → ${outDir}`,
    `  编码: ${decoded.encoding}`,
    `  profile: ${profileName} (${chosenBy})`,
    `  字符: ${decoded.text.length} | 规范化行数: ${lines.length}`,
    `  分段: ${segments.length}（${segmented ? '结构分段' : '固定切块'}）→ ${ranges.length} 个处理范围`,
    `  候选: ${census.rows.length} 个高频实体${aliasHints.length ? ` | 别名线索 ${aliasHints.length} 条` : ''}`,
    `  产物: transcode / segments.json / census.json${candidatesWritten ? ' / candidates.md(新建)' : candidatesWritten === false && census.rows.length ? ' / candidates.md(保留已有)' : ''}${progressWritten ? ' / progress.md(新建)' : ' / progress.md(保留已有)'}`,
  ];
  process.stdout.write(out.join('\n') + '\n');

  const meta = {
    command: 'prepare',
    source: path.resolve(source),
    vault,
    outDir,
    encoding: decoded.encoding,
    profile: profileName,
    profileChosenBy: chosenBy,
    detectMatches,
    chars: decoded.text.length,
    lineCount: lines.length,
    segmented,
    segmentCount: segments.length,
    rangeCount: ranges.length,
    candidateCount: census.rows.length,
    aliasHintCount: aliasHints.length,
    candidatesWritten,
    progressWritten,
    outputs: files,
    warnings,
  };
  process.stderr.write(JSON.stringify(meta) + '\n');
  process.exit(0);
}

// ─── status ───

function countCheckboxes(text, sectionPrefix) {
  // Count - [ ] / - [x] rows, optionally only within a `## <prefix>` section.
  let done = 0, total = 0;
  let inSection = !sectionPrefix;
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) {
      inSection = !sectionPrefix || line.startsWith(`## ${sectionPrefix}`);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*-\s*\[([ xX])\]/);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

function cmdStatus(opts) {
  const source = opts._[1] || opts._[0];
  if (!source) { usage(); process.exit(1); }
  const vault = path.resolve(opts.vault || process.cwd());
  const stem = stemOf(source);
  const outDir = outDirFor(vault);
  const progressFile = path.join(outDir, `progress-${stem}.md`);
  const candidatesFile = path.join(outDir, `candidates-${stem}.md`);

  const result = {
    stem,
    outDir,
    progressExists: fs.existsSync(progressFile),
    rangesDone: 0, rangesTotal: 0, rangesChecked: 0, missingRanges: [],
    candidatesDone: 0, candidatesTotal: 0,
    l3Done: false,
    complete: false,
  };
  if (result.progressExists) {
    const progress = fs.readFileSync(progressFile, 'utf8');
    const ranges = countCheckboxes(progress, 'L1 范围清单');
    result.rangesChecked = ranges.done;
    result.rangesTotal = ranges.total;
    const l3 = countCheckboxes(progress, 'L3 长尾');
    result.l3Done = l3.total > 0 && l3.done === l3.total;
  }

  // Authoritative L1 progress = digest files on disk, NOT checkboxes.
  // Workflow/background subagents write digests/R###.md but are not
  // disciplined about checking progress boxes; the filesystem is the truth.
  // (A real 74-range novel build surfaced this: 18 digests, 0 boxes checked.)
  const digestsDir = path.join(outDir, 'digests');
  if (fs.existsSync(digestsDir)) {
    const done = new Set();
    for (const f of fs.readdirSync(digestsDir)) {
      const m = f.match(/^R(\d+)\.md$/);
      if (m) done.add(parseInt(m[1], 10));
    }
    result.rangesDone = done.size;
    for (let i = 1; i <= result.rangesTotal; i++) {
      if (!done.has(i)) result.missingRanges.push(`R${String(i).padStart(3, '0')}`);
    }
  } else {
    result.rangesDone = result.rangesChecked; // fallback: checkbox count
  }

  if (fs.existsSync(candidatesFile)) {
    const cands = countCheckboxes(fs.readFileSync(candidatesFile, 'utf8'), null);
    result.candidatesDone = cands.done;
    result.candidatesTotal = cands.total;
  }
  result.complete =
    result.rangesTotal > 0 &&
    result.rangesDone === result.rangesTotal &&
    result.candidatesDone === result.candidatesTotal;

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ─── verify ───

function cmdVerify(opts) {
  const [pagePath, sourcePath] = opts._.slice(1);
  if (!pagePath || !sourcePath) { usage(); process.exit(1); }
  let page, source;
  try {
    page = fs.readFileSync(pagePath, 'utf8');
    source = fs.readFileSync(sourcePath, 'utf8').replace(/\s+/g, '');
  } catch (e) {
    process.stderr.write(`[prep] ERROR: ${e.message}\n`);
    process.exit(2);
  }

  const quotes = new Set();
  const add = (q) => {
    const norm = q.replace(/\s+/g, '');
    if (norm.length >= 6 && norm.length <= 120) quotes.add(norm);
  };
  for (const m of page.matchAll(/「([^」\n]{6,120})」/g)) add(m[1]);
  for (const m of page.matchAll(/“([^”\n]{6,120})”/g)) add(m[1]);
  for (const line of page.split('\n')) {
    const bq = line.match(/^\s*>\s*(.{6,120})$/);
    if (bq) add(bq[1]);
  }

  const missing = [];
  let found = 0;
  for (const q of quotes) {
    if (source.includes(q)) found++;
    else missing.push(q);
  }

  process.stdout.write(JSON.stringify({
    page: path.resolve(pagePath),
    source: path.resolve(sourcePath),
    checked: quotes.size,
    found,
    missing,
  }, null, 2) + '\n');
  process.exit(0);
}

// ─── main ───

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts._.length) { usage(); process.exit(opts.help ? 0 : 1); }

  const command = opts._[0];
  if (command === 'status') return cmdStatus(opts);
  if (command === 'verify') return cmdVerify(opts);
  return cmdPrepare(opts); // default: first arg is the source path
}

try {
  main();
} catch (e) {
  process.stderr.write(`[prep] ERROR: ${e && e.message ? e.message : e}\n`);
  process.exit(4);
}
