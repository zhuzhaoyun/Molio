// verify-drafts.mjs — 批次 vs drafts 落盘对账（硬性门禁，治"超限截断静默缺失"）
//
// 用法: node verify-drafts.mjs <stem> [--vault <dir>]
// 读取:
//   batches/*.tsv —— 批次声明要建的页面清单（每行第一列 = 规范名）
//   drafts/*.md  —— 建页 subagent 实际落盘的草稿
// 检查:
//   - 批次声明但 drafts 缺失的文件
//   - drafts 存在但内容为空（0 字节）的文件
// 任一缺失/为空 → exit 1，报清单。exit 0 = 批次与落盘完全一致。
//
// 治的坑：subagent 单次输出超限被截断后"以为自己写完了"，产物静默缺失；
// 以及"报告写了卫青，文件实际不存在"（建页漏写）。两者最终都表现为
// "批次声明了但文件没落盘"，一个门禁统一定位。
// 零 LLM，确定性。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node verify-drafts.mjs <stem> [--vault <dir>]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const batchesDir = path.join(wd, 'batches');
const draftsDir = path.join(wd, 'drafts');

if (!fs.existsSync(batchesDir)) {
  console.error(`batches 目录不存在: ${batchesDir}`);
  process.exit(1);
}
if (!fs.existsSync(draftsDir)) {
  console.error(`drafts 目录不存在: ${draftsDir}`);
  process.exit(1);
}

// 1. 批次声明清单（去重，保留原名）
const declared = new Map(); // name -> 所在批次文件
for (const f of fs.readdirSync(batchesDir).filter(f => f.endsWith('.tsv'))) {
  for (const raw of fs.readFileSync(path.join(batchesDir, f), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const name = line.split('\t')[0].trim();
    if (name && !declared.has(name)) declared.set(name, f);
  }
}

// 2. drafts 实际落盘
const draftsOnDisk = new Set(
  fs.readdirSync(draftsDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
);

// 3. 对账
const missing = [];   // 声明了但没落盘
const empty = [];     // 落盘但 0 字节

for (const [name, batchFile] of declared) {
  if (!draftsOnDisk.has(name)) missing.push({ name, batchFile });
}
for (const f of fs.readdirSync(draftsDir).filter(f => f.endsWith('.md'))) {
  const p = path.join(draftsDir, f);
  if (fs.statSync(p).size === 0) empty.push(f.replace(/\.md$/, ''));
}

const totalDeclared = declared.size;
const totalDrafts = draftsOnDisk.size;
const ok = missing.length === 0 && empty.length === 0;

console.log(JSON.stringify({
  ok,
  totalDeclared,
  totalDrafts,
  missingCount: missing.length,
  emptyCount: empty.length,
  missing,
  empty,
}, null, 2));

if (!ok) {
  process.exit(1);
}