// curate.mjs — 长文档构建的 curation 管线（替代 merge-master + alias-table + manifest + batcher）
//
// 两个子命令：
//   curate.mjs draft <stem> [--vault <dir>] [--min-count <N>]
//     读 census-<stem>.json → 产出 curation-draft.tsv（预填草稿，供 agent 审核）
//     census 为空时产出空模板（agent 从零填写）
//
//   curate.mjs split <stem> [--vault <dir>] [--max-per-batch <N>]
//     读 agent 审核后的 curation-<stem>.tsv → 校验格式 → 按 # cat= 分组
//     → 单批超 max-per-batch 自动拆分 → 输出 batches/batch-NN.tsv
//
// 批次 TSV 格式（制表符分隔，每行 5 列）：
//   名字 \t 定性 \t 别名: X/Y/Z \t 证据行号: N,N,N \t 页类: entity|concept
//   文件首行：# cat=<类别标签>
//
// 零 LLM，确定性。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [cmd, stem] = opts._;

if (!cmd || !['draft', 'split'].includes(cmd)) {
  console.error('用法: node curate.mjs draft|split <stem> [--vault <dir>]');
  process.exit(1);
}
if (!stem) {
  console.error('缺少 <stem> 参数');
  process.exit(1);
}

const vault = resolveVault(opts);
const wd = buildDir(vault);

// ─── draft：census → 预填草稿 ───

if (cmd === 'draft') {
  const minCount = parseInt(opts.minCount || '2', 10);
  const censusFile = path.join(wd, `census-${stem}.json`);
  const outFile = path.join(wd, `curation-draft-${stem}.tsv`);

  if (!fs.existsSync(censusFile)) {
    console.error(`census 不存在: ${censusFile}`);
    process.exit(1);
  }

  const census = JSON.parse(fs.readFileSync(censusFile, 'utf8'));
  const rows = census.rows || [];
  const aliasHints = census.aliasHints || {};
  // excludedCommonWords 可能是数组（词表）或数字（计数），兼容两种
  const excludedRaw = census.excludedCommonWords || [];
  const excluded = new Set(Array.isArray(excludedRaw) ? excludedRaw : []);

  // 构建 aliasHints 的唯一匹配表（一个别名只指向一个规范名才预填）
  const aliasOwners = new Map(); // alias -> Set(canonical)
  for (const hint of Object.values(aliasHints)) {
    if (!hint || !hint.a || !hint.b) continue;
    // aliasHints 格式: {a, b, context} — a 和 b 是互指的两个名字
    if (!aliasOwners.has(hint.a)) aliasOwners.set(hint.a, new Set());
    aliasOwners.get(hint.a).add(hint.b);
    if (!aliasOwners.has(hint.b)) aliasOwners.set(hint.b, new Set());
    aliasOwners.get(hint.b).add(hint.a);
  }

  // 过滤 + 排序
  const candidates = rows
    .filter(r => r.count >= minCount && !excluded.has(r.surface))
    .sort((a, b) => b.count - a.count);

  // 产出草稿 TSV
  const lines = ['# cat=待分组（agent 审核后按主题分组，每组一个 # cat= 标签）'];
  for (const r of candidates) {
    const name = r.surface;
    const qual = `count ${r.count}`;
    // 别名预填：只有唯一匹配才填
    const owners = aliasOwners.get(name);
    const alias = owners && owners.size === 1 ? `别名: ${[...owners][0]}` : '别名: ';
    // 证据行号：census rows 里没有 lines 字段（只有 surface/count/cats），留空让 agent 补
    const evidence = '证据行号: ';
    const pageType = '页类: entity';
    lines.push([name, qual, alias, evidence, pageType].join('\t'));
  }

  if (candidates.length === 0) {
    // census 为空 → 产出空模板
    lines.push('# （census 无候选，agent 需从文本中手动提取候选填入此文件）');
  }

  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(JSON.stringify({
    censusRows: rows.length,
    candidates: candidates.length,
    filteredOut: rows.length - candidates.length,
    aliasPrefilled: lines.filter(l => l.includes('别名: ') && !l.endsWith('别名: ')).length,
    output: outFile,
  }, null, 2));
}

// ─── split：审核后 TSV → 校验 + 分批 ───

if (cmd === 'split') {
  const maxPerBatch = parseInt(opts.maxPerBatch || '15', 10);
  const inputFile = path.join(wd, `curation-${stem}.tsv`);
  const batchesDir = path.join(wd, 'batches');

  if (!fs.existsSync(inputFile)) {
    console.error(`审核后的 curation 文件不存在: ${inputFile}\n请先运行 draft 并由 agent 审核产出此文件。`);
    process.exit(1);
  }

  // 解析 TSV：按 # cat= 分组
  const groups = []; // [{ cat, items: [{name, qual, alias, evidence, pageType}] }]
  let currentGroup = null;
  const errors = [];

  for (const [lineNo, raw] of fs.readFileSync(inputFile, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('# （')) continue;

    if (line.startsWith('# cat=')) {
      currentGroup = { cat: line.slice(6).trim(), items: [] };
      groups.push(currentGroup);
      continue;
    }
    if (line.startsWith('#')) continue; // 其他注释行

    if (!currentGroup) {
      errors.push(`行 ${lineNo + 1}: 数据行出现在任何 # cat= 之前`);
      continue;
    }

    const cols = line.split('\t');
    if (cols.length < 5) {
      errors.push(`行 ${lineNo + 1}: 列数不足 5（实际 ${cols.length}）`);
      continue;
    }

    const [name, qual, alias, evidence, pageType] = cols.map(c => c.trim());
    if (!name) { errors.push(`行 ${lineNo + 1}: 名字为空`); continue; }
    if (!/^页类:\s*(entity|concept)$/.test(pageType)) {
      errors.push(`行 ${lineNo + 1}: 页类必须是 "页类: entity" 或 "页类: concept"（实际 "${pageType}"）`);
      continue;
    }

    currentGroup.items.push({ name, qual, alias, evidence, pageType });
  }

  if (errors.length > 0) {
    console.error(`TSV 校验失败（${errors.length} 处错误）：`);
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    if (errors.length > 20) console.error(`  ... 还有 ${errors.length - 20} 处`);
    process.exit(1);
  }

  // 分批：单批超 maxPerBatch 自动拆分
  fs.mkdirSync(batchesDir, { recursive: true });
  for (const f of fs.readdirSync(batchesDir)) fs.rmSync(path.join(batchesDir, f));

  let batchNo = 0;
  const summary = [];
  for (const group of groups) {
    const chunks = [];
    for (let i = 0; i < group.items.length; i += maxPerBatch) {
      chunks.push(group.items.slice(i, i + maxPerBatch));
    }
    for (const chunk of chunks) {
      batchNo++;
      const fileName = `batch-${String(batchNo).padStart(2, '0')}.tsv`;
      const lines = [`# cat=${group.cat}`];
      for (const item of chunk) {
        lines.push([item.name, item.qual, item.alias, item.evidence, item.pageType].join('\t'));
      }
      fs.writeFileSync(path.join(batchesDir, fileName), lines.join('\n') + '\n');
      summary.push({ file: fileName, cat: group.cat, count: chunk.length });
    }
  }

  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);
  const entityCount = groups.reduce((s, g) => s + g.items.filter(i => i.pageType === '页类: entity').length, 0);
  const conceptCount = totalItems - entityCount;

  // 写 summary
  fs.writeFileSync(path.join(batchesDir, 'summary.json'), JSON.stringify({
    stem, totalItems, entityCount, conceptCount,
    batchCount: batchNo, maxPerBatch,
    batches: summary,
  }, null, 2));

  console.log(JSON.stringify({
    totalItems, entityCount, conceptCount,
    batchCount: batchNo,
    groupsCount: groups.length,
    output: batchesDir,
  }, null, 2));
}