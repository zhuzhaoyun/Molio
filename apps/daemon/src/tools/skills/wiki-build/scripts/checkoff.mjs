// checkoff.mjs — 两用：
//   A) <-c, 默认> candidates-<stem>.md 全量打勾（原功能）
//   B) 产物门禁（硬性，exit 1 即构建中止）：
//      gate-l2a <stem>  — 校验 L2a 产物齐全：entity-master 三表存在非空 + aliases 存在
//                          + master 条目覆盖 manifest 声明的完整页/stub
//      gate-l2b <stem>  — 校验 L2b 产物齐全：manifest 声明的每页在 wiki/ 有对应文件
// 用法: node checkoff.mjs [<stem>] [gate-l2a|gate-l2b] [--vault <dir>] [--expect <N>]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const args = opts._.slice();
const mode = args.includes('gate-l2a') ? 'gate-l2a' : args.includes('gate-l2b') ? 'gate-l2b' : 'checkoff';
const stem = args.find((a) => a !== 'gate-l2a' && a !== 'gate-l2b') || null;

const vault = resolveVault(opts);
const wd = buildDir(vault);

function fail(msg) {
  console.error(`GATE FAIL: ${msg}`);
  process.exit(1);
}

/** 从 manifest 解析 [完整页|stub] 清单；不建页不在此列 */
function readManifestPages() {
  if (!stem) fail('缺少 <stem> 参数');
  const file = path.join(wd, `page-manifest-${stem}.md`);
  if (!fs.existsSync(file)) fail(`manifest 不存在: ${file}`);
  const full = [];
  const stub = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const [name, tier] = line.slice(2).split('｜').map((x) => x.trim());
    if (!name || !tier) continue;
    if (tier === '完整页') full.push(name);
    else if (tier === 'stub') stub.push(name);
  }
  return { full, stub, all: [...full, ...stub] };
}

/** 从 master 表第 1 列读出规范名集合 */
function readMasterNames() {
  const names = new Set();
  for (const f of ['entity-master-persons.md', 'entity-master-others.md']) {
    const p = path.join(wd, f);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('- ')) continue;
      const name = line.slice(2).split('｜')[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** 收集 wiki/ 下所有 .md 文件名（含顶层，不含 INDEX/log/hot），返回 basename 集合 */
function readWikiPages() {
  const pages = new Set();
  const skip = new Set(['INDEX.md', 'log.md', 'hot.md']);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && !skip.has(e.name)) pages.add(e.name.replace(/\.md$/, ''));
    }
  };
  walk(path.join(vault, 'wiki'));
  return pages;
}

if (mode === 'checkoff') {
  if (!stem) fail('checkoff 需要 <stem>');
  const candFile = path.join(wd, `candidates-${stem}.md`);
  if (!fs.existsSync(candFile)) fail(`candidates 不存在: ${candFile}`);
  let text = fs.readFileSync(candFile, 'utf8');
  const before = (text.match(/^- \[ \]/gm) || []).length;
  text = text.replace(/^- \[ \]/gm, '- [x]');
  if (!text.includes('判定明细')) {
    text = text.replace(/^(# 候选实体.*\n)/, '$1\n> 三档判定与噪音说明见 candidates-reconciliation-*.md。\n');
  }
  fs.writeFileSync(candFile, text);
  const after = (text.match(/^- \[ \]/gm) || []).length;
  console.log(JSON.stringify({ uncheckedBefore: before, uncheckedAfter: after }));
  process.exit(0);
}

if (mode === 'gate-l2a') {
  const { all } = readManifestPages();
  // 1. 主表三件套
  for (const f of ['entity-master-persons.md', 'entity-master-others.md', 'entity-master-disputes.md']) {
    const p = path.join(wd, f);
    if (!fs.existsSync(p)) fail(`L2a 缺失 ${f}`);
    const txt = fs.readFileSync(p, 'utf8');
    if (['entity-master-persons.md', 'entity-master-others.md'].includes(f) && (txt.match(/^- /gm) || []).length === 0) {
      fail(`L2a ${f} 无实体条目`);
    }
  }
  // 2. aliases（有 stem）
  const aliasesFile = path.join(wd, `aliases-${stem}.json`);
  if (!fs.existsSync(aliasesFile)) fail(`L2a 缺失 aliases-${stem}.json`);
  const aliases = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
  if (Object.keys(aliases).length === 0) fail(`aliases-${stem}.json 为空（别名表空 = linkpass 将无词可链）`);

  // 3. master 覆盖 manifest 声明的页面（允许 EXTRA/别名造成的少量差异，<5% 容差）
  const master = readMasterNames();
  const missing = all.filter((n) => !master.has(n));
  if (missing.length > 0) {
    const pct = missing.length / all.length;
    if (pct <= 0.05) {
      console.log(JSON.stringify({ gate: 'l2a', warn: `master 缺 ${missing.length} 个 manifest 页（≤5%，容差内）：${missing.slice(0, 8).join(', ')}` }));
    } else {
      fail(`master 表缺 ${missing.length}/${all.length} 个 manifest 页面（>5%）：${missing.slice(0, 10).join(', ')}`);
    }
  }
  console.log(JSON.stringify({ gate: 'l2a', pass: true, manifestPages: all.length, aliases: Object.keys(aliases).length }));
  process.exit(0);
}

if (mode === 'gate-l2b') {
  const { all } = readManifestPages();
  const pages = readWikiPages();
  const missing = all.filter((n) => !pages.has(n));
  if (missing.length > 0) {
    fail(`L2b 缺 ${missing.length}/${all.length} 个页面：${missing.slice(0, 10).join(', ')}`);
  }
  console.log(JSON.stringify({ gate: 'l2b', pass: true, manifestPages: all.length, wikiPages: pages.size }));
  process.exit(0);
}