#!/usr/bin/env node
/**
 * 校验 content/market/*.json 的字段完整性与「事实数字」是否和本地 wiki 对得上。
 *
 * 用法（仓库根目录）：
 *   node apps/cloud/scripts/check-market-content.mjs
 *   MOLIO_RESOURCE_ROOT=D:/work/molio_resource node apps/cloud/scripts/check-market-content.mjs
 *
 * 只读，不写数据库。退出码 1 = 有硬错误；0 = 通过（可能有 warning）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const contentDir = path.join(root, 'content', 'market');
const resourceRoot = process.env.MOLIO_RESOURCE_ROOT || 'D:/work/molio_resource';
const map = JSON.parse(readFileSync(path.join(contentDir, 'product-map.json'), 'utf8'));

const errors = [];
const warnings = [];

function countMd(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += countMd(p);
    else if (ent.name.endsWith('.md') && !['INDEX.md', 'log.md'].includes(ent.name)) n += 1;
  }
  return n;
}

function wikiCounts(wikiDir) {
  const base = path.join(resourceRoot, wikiDir);
  const wiki = existsSync(path.join(base, 'wiki')) ? path.join(base, 'wiki') : base;
  const all = countMd(wiki);
  const concepts = countMd(path.join(wiki, 'concepts'));
  const comparisons = countMd(path.join(wiki, 'comparisons'));
  const entities = countMd(path.join(wiki, 'entities'));
  const sources = countMd(path.join(wiki, 'sources'));
  return { all, concepts, comparisons, entities, sources };
}

function num(s) {
  const m = String(s).replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

function checkFact(fact, counts, id) {
  const label = String(fact.label || '').trim();
  const value = num(fact.value);
  if (value === null) return;
  let expected = null;
  let tolerance = 0;
  // 只校验「无限定词」的总量；带“历史/专题/六十四卦”等限定词的是子集，跳过。
  if (label === '概念页') expected = counts.concepts;
  else if (label === '对比页') expected = counts.comparisons;
  else if (label === '实体页') expected = counts.entities;
  else if (label === '源摘要' || label === '来源摘要') expected = counts.sources;
  else if (label === '内容页' || label === '总页面' || label === '页面总数') {
    expected = counts.concepts + counts.comparisons + counts.entities + counts.sources;
    tolerance = 10; // 概述页/附页口径可能不同
  }
  if (expected !== null && Math.abs(value - expected) > tolerance) {
    errors.push(`${id}: fact「${label}」= ${value}，本地 wiki 参考 ${expected}（容差 ${tolerance}）`);
  }
}

const files = readdirSync(contentDir).filter((n) => n.endsWith('.json') && n !== 'product-map.json');
console.log('[check-content] files:', files.length);
for (const name of files) {
  const id = name.slice(0, -'.json'.length);
  const meta = map[id];
  if (!meta) { warnings.push(`${id}: product-map.json 里没有这个 ID`); continue; }
  let data;
  try { data = JSON.parse(readFileSync(path.join(contentDir, name), 'utf8')); }
  catch (e) { errors.push(`${id}: JSON 解析失败 ${e.message}`); continue; }

  if (data.version !== 1) errors.push(`${id}: version != 1`);
  if (!data.positioning?.what) errors.push(`${id}: positioning.what 缺失`);
  if (!Array.isArray(data.facts) || data.facts.length === 0) errors.push(`${id}: facts 缺失`);
  if (!Array.isArray(data.themes) || data.themes.length === 0) errors.push(`${id}: themes 缺失`);
  if (!Array.isArray(data.questions)) errors.push(`${id}: questions 不是数组`);
  else if (data.questions.length < 3) warnings.push(`${id}: questions 只有 ${data.questions.length} 条（建议 3-5）`);
  if (!Array.isArray(data.samples) || data.samples.length === 0) warnings.push(`${id}: samples 为空（建议 1-2 条）`);
  if (!data.delivery?.format) errors.push(`${id}: delivery.format 缺失`);
  if (!data.review?.basis || !data.review?.reviewedAt) errors.push(`${id}: review 缺失`);

  const counts = wikiCounts(meta.wikiDir);
  for (const f of data.facts ?? []) checkFact(f, counts, id);

  const totalItems = (data.themes ?? []).reduce((n, t) => n + (Array.isArray(t.items) ? t.items.length : 0), 0);
  console.log(`  - ${id} ${meta.name}: facts=${data.facts?.length ?? 0} themes=${data.themes?.length ?? 0} items=${totalItems} q=${data.questions?.length ?? 0} samples=${data.samples?.length ?? 0} | wiki concept=${counts.concepts} comp=${counts.comparisons} ent=${counts.entities} src=${counts.sources} all=${counts.all}`);
}

if (warnings.length) {
  console.log('\n[check-content] warnings:');
  for (const w of warnings) console.log('  ⚠', w);
}
if (errors.length) {
  console.log('\n[check-content] errors:');
  for (const e of errors) console.log('  ✖', e);
  process.exitCode = 1;
} else {
  console.log('\n[check-content] ok');
}
