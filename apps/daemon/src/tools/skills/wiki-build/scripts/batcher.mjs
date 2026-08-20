// batcher.mjs — 读取 page-manifest-<stem>.md，把完整页/stub 分成 L2b 建页批次
// 用法: node batcher.mjs <stem> [--vault <dir>]
// 读取: <vault>/.molio/wiki-build/page-manifest-<stem>.md
// 产出: <vault>/.molio/wiki-build/batches/batch-full-NN.list
//       <vault>/.molio/wiki-build/batches/batch-stub-NN.list
//       <vault>/.molio/wiki-build/batches/summary.json
// 零 LLM，确定性；批次大小可经 rules.json 覆盖：
//   { "batch": { "full": 8, "stub": 30 } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node batcher.mjs <stem> [--vault <dir>]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const manifest = path.join(wd, `page-manifest-${stem}.md`);
const outDir = path.join(wd, 'batches');
const rules = loadRules(vault);
const FULL_PER_BATCH = rules.batch?.full ?? 8;
const STUB_PER_BATCH = rules.batch?.stub ?? 30;

if (!fs.existsSync(manifest)) {
  console.error(`manifest 不存在: ${manifest}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, f));

const full = [], stub = [], none = [];
for (const raw of fs.readFileSync(manifest, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line.startsWith('- ')) continue;
  const [name, tier] = line.slice(2).split('｜').map((x) => x.trim());
  if (!name || !tier) continue;
  if (tier === '完整页') full.push(name);
  else if (tier === 'stub') stub.push(name);
  else none.push(name);
}

function writeBatches(list, size, prefix) {
  const n = [];
  for (let i = 0; i < list.length; i += size) {
    const idx = String(n.length + 1).padStart(2, '0');
    const file = path.join(outDir, `${prefix}-${idx}.list`);
    fs.writeFileSync(file, list.slice(i, i + size).join('\n') + '\n');
    n.push(`${prefix}-${idx}`);
  }
  return n;
}

const fullBatches = writeBatches(full, FULL_PER_BATCH, 'batch-full');
const stubBatches = writeBatches(stub, STUB_PER_BATCH, 'batch-stub');

fs.writeFileSync(
  path.join(outDir, 'summary.json'),
  JSON.stringify({ full: full.length, stub: stub.length, none: none.length, fullBatches, stubBatches }, null, 2),
);
console.log(JSON.stringify({
  manifest, full: full.length, fullBatches: fullBatches.length,
  stub: stub.length, stubBatches: stubBatches.length, none: none.length,
}, null, 2));