// sweep.mjs — 对 wiki 全部页面批量跑 prep.mjs verify，汇总 missing 非空的页面
// 用法: node sweep.mjs <stem> [--vault <dir>]
// 读取: <vault>/.molio/wiki-build/transcode-<stem>.txt 作为原文底本
// 目录清单来自 rules.json（可选）: { "sweep": { "dirs": ["wiki/entities", "wiki/sources", "wiki/concepts"] } }
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node sweep.mjs <stem> [--vault <dir>]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prep = path.join(__dirname, 'prep.mjs');
const transcode = path.join(wd, `transcode-${stem}.txt`);
const rules = loadRules(vault).sweep || {};
const dirs = rules.dirs || ['wiki/entities', 'wiki/sources', 'wiki/concepts'];

if (!fs.existsSync(transcode)) {
  console.error(`transcode 不存在: ${transcode}`);
  process.exit(1);
}

const targets = [];
for (const dir of dirs) {
  const d = path.join(vault, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.md') && f !== 'INDEX.md') targets.push(path.join(d, f));
  }
}
for (const f of fs.readdirSync(path.join(vault, 'wiki'))) {
  if (f.endsWith('.md') && !['INDEX.md', 'log.md', 'hot.md'].includes(f)) targets.push(path.join(vault, 'wiki', f));
}

let checkedPages = 0;
let quotedPages = 0;
const failures = [];
for (const t of targets) {
  let out;
  try {
    out = execFileSync('node', [prep, 'verify', t, transcode], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    failures.push({ page: t, error: String(e.message).slice(0, 120) });
    continue;
  }
  try {
    const j = JSON.parse(out);
    checkedPages++;
    if (j.checked > 0) quotedPages++;
    if (j.missing && j.missing.length) failures.push({ page: path.relative(vault, t), missing: j.missing });
  } catch {
    failures.push({ page: path.relative(vault, t), error: 'parse-fail' });
  }
}
console.log(JSON.stringify({ total: targets.length, checkedPages, quotedPages, failures }, null, 2));