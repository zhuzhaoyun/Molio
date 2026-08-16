// merge-master.mjs — 确定性合并 merge/ 下所有中间表/切片为实体主表（零 LLM）
// 用法: node merge-master.mjs [--vault <dir>]
// 读取: <vault>/.molio/wiki-build/merge/ 全部 M*.md 的
//       "## 人物 / ## 地点物品结社 / ## 别名与存疑" 小节
// 产出: entity-master-persons.md / entity-master-others.md / entity-master-disputes.md（在 workdir 下）
// 语料特定人工表（优先名单 / 补充归并 / 群组保护）来自 rules.json:
//   { "merge": { "preferredCanon": [...], "extraMerges": {别名: 规范名}, "noAutoMergeGroups": true } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const vault = resolveVault(opts);
const wd = buildDir(vault);
const mergeDir = path.join(wd, 'merge');
const rules = loadRules(vault).merge || {};

const entries = new Map(); // key: 规范名|section -> record
const disputes = [];
const fileStats = [];

function parseRangeTokens(s) {
  // 从分布字段提取 R### 集合
  const set = new Set();
  const cleaned = stripLabel(String(s), ['分布：', '分布:']).replace(/[（(][^）)]*[）)]/g, '');
  for (const tok of cleaned.split(/[,，、\s]+/)) {
    const m = tok.match(/^R(\d{3})(?:\s*[-~—]\s*R?(\d{3}))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

function compressRanges(nums) {
  if (!nums.length) return '';
  const sorted = [...new Set(nums)].sort((x, y) => x - y);
  const out = [];
  let s = sorted[0];
  let p = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === p + 1) { p = n; continue; }
    out.push(s === p ? `R${String(s).padStart(3, '0')}` : `R${String(s).padStart(3, '0')}-R${String(p).padStart(3, '0')}`);
    s = p = n;
  }
  return out.join(',');
}

function stripLabel(v, labels) {
  let t = String(v).trim();
  for (const l of labels) {
    if (t.startsWith(l)) { t = t.slice(l.length).trim(); break; }
  }
  return t;
}

function parseFirstAppearance(v) {
  const t = stripLabel(v, ['首现：', '首现:']);
  const m = t.match(/L\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const files = fs.readdirSync(mergeDir).filter((f) => /^M.*\.md$/.test(f)).sort();
if (!files.length) {
  console.error(`merge/ 下没有 M*.md 中间表: ${mergeDir}`);
  process.exit(1);
}
for (const f of files) {
  const lines = fs.readFileSync(path.join(mergeDir, f), 'utf8').split(/\r?\n/);
  let section = null;
  let parsed = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^###/.test(line)) continue; // 三级子标题不改变当前小节状态
    const h = line.match(/^##(?!#)\s*(.*)$/);
    if (h) {
      const t = h[1];
      if (/人物|实体/.test(t)) section = 'persons';
      else if (/地点|物品|结社/.test(t)) section = 'others';
      else if (/别名|存疑|待仲裁/.test(t)) section = 'disputes';
      else section = null;
      continue;
    }
    if (/^#\s/.test(line)) { section = null; continue; }
    if (!section || !line.startsWith('- ')) continue;
    const body = line.slice(2);
    if (section === 'disputes') {
      disputes.push(`- （${f}）${body}`);
      continue;
    }
    const fields = body.split('｜').map((x) => x.trim());
    if (fields.length < 2) continue;
    const name = fields[0].replace(/^\d+\.\s*/, '').trim();
    if (!name) continue;
    const key = `${section}|${name}`;
    let rec = entries.get(key);
    if (!rec) {
      rec = { name, section, aliases: new Set(), identities: [], ranges: new Set(), first: null, files: [] };
      entries.set(key, rec);
    }
    rec.files.push(f);
    if (section === 'persons' && fields.length >= 5) {
      const al = stripLabel(fields[1], ['别名：', '别名:']);
      if (al && al !== '无') for (const a of al.split(/[,，、]/)) { const t = a.trim(); if (t && t !== '无') rec.aliases.add(t); }
      const id = stripLabel(fields[2], ['身份：', '身份:']);
      if (id) rec.identities.push(id);
      for (const n of parseRangeTokens(fields[3])) rec.ranges.add(n);
      const fa = parseFirstAppearance(fields[4]);
      if (fa !== null && (rec.first === null || fa < rec.first)) rec.first = fa;
    } else if (section === 'others' && fields.length >= 5) {
      // 名称｜类别｜说明｜分布｜首现 —— 类别并入身份槽
      const cat = fields[1];
      const desc = stripLabel(fields[2], ['说明：', '说明:']);
      rec.identities.push(`${cat}：${desc}`);
      for (const n of parseRangeTokens(fields[3])) rec.ranges.add(n);
      const fa = parseFirstAppearance(fields[4]);
      if (fa !== null && (rec.first === null || fa < rec.first)) rec.first = fa;
    } else {
      // 字段不齐：整行存入 identities 待人工看
      rec.identities.push(`[格式异常@${f}] ${body}`);
      for (const n of parseRangeTokens(body)) rec.ranges.add(n);
    }
    parsed++;
  }
  fileStats.push(`${f}: ${parsed} 条`);
}

const PREFERRED_CANON = new Set(rules.preferredCanon || []);
const EXTRA_MERGES = rules.extraMerges || {};
const PROTECT_GROUPS = rules.noAutoMergeGroups !== false; // 群组条目（名字含"等"）不自动归并，默认保护

function crossAliasMerge(entriesMap, section) {
  const recs = [...entriesMap.values()].filter((r) => r.section === section);
  const byName = new Map(recs.map((r) => [r.name, r]));
  let changed = true;
  const mergedLog = [];
  while (changed) {
    changed = false;
    for (const rec of recs) {
      if (rec.merged) continue;
      for (const al of rec.aliases) {
        const target = byName.get(al);
        if (target && target !== rec && !target.merged && target.section === section) {
          if (PROTECT_GROUPS && (/等/.test(rec.name) || /等/.test(target.name))) continue; // 群组条目不自动归并
          // rec 与 target 互为别名指向同一实体；保留名字较长者为规范名（优先名单例外）
          let [keep, drop] = rec.name.length >= target.name.length ? [rec, target] : [target, rec];
          if (PREFERRED_CANON.has(drop.name) && !PREFERRED_CANON.has(keep.name)) [keep, drop] = [drop, keep];
          for (const a of drop.aliases) if (a !== keep.name) keep.aliases.add(a);
          keep.aliases.add(drop.name);
          keep.identities.push(...drop.identities);
          for (const n of drop.ranges) keep.ranges.add(n);
          if (drop.first !== null && (keep.first === null || drop.first < keep.first)) keep.first = drop.first;
          drop.merged = true;
          mergedLog.push(`${drop.name} → ${keep.name}`);
          changed = true;
          break;
        }
      }
    }
  }
  return mergedLog;
}

function render(rec) {
  const al = [...rec.aliases].join(',');
  let identity;
  const uniq = [...new Set(rec.identities.map((x) => x.trim()).filter(Boolean))];
  let conflicted = false;
  if (uniq.length <= 1) identity = uniq[0] || '待补';
  else {
    conflicted = true;
    identity = uniq.sort((a, b) => b.length - a.length)[0] + '（存疑）';
    disputes.push(`- 身份矛盾｜${rec.name}：${uniq.join(' ／ ')}`);
  }
  const dist = compressRanges([...rec.ranges]) || '未标';
  const first = rec.first !== null ? `L${rec.first}` : '未标';
  return { line: `- ${rec.name}｜别名：${al || '无'}｜身份：${identity}｜分布：${dist}｜首现：${first}`, conflicted, first: rec.first ?? Infinity };
}

const mergesP = crossAliasMerge(entries, 'persons');
const mergesO = crossAliasMerge(entries, 'others');

// 应用人工补充归并
for (const [dropName, keepName] of Object.entries(EXTRA_MERGES)) {
  const drop = entries.get(`persons|${dropName}`) || entries.get(`others|${dropName}`);
  const keep = entries.get(`persons|${keepName}`) || entries.get(`others|${keepName}`);
  if (!drop || !keep || drop === keep || drop.merged) {
    if (drop && !keep) console.error(`EXTRA_MERGE 目标缺失: ${dropName} → ${keepName}`);
    continue;
  }
  for (const a of drop.aliases) if (a !== keep.name) keep.aliases.add(a);
  keep.aliases.add(drop.name);
  keep.identities.push(...drop.identities);
  for (const n of drop.ranges) keep.ranges.add(n);
  if (drop.first !== null && (keep.first === null || drop.first < keep.first)) keep.first = drop.first;
  drop.merged = true;
  mergesP.push(`${dropName} → ${keepName}（人工）`);
}
const persons = [...entries.values()].filter((r) => r.section === 'persons' && !r.merged);
const others = [...entries.values()].filter((r) => r.section === 'others' && !r.merged);
const pLines = persons.map(render).sort((a, b) => a.first - b.first);
const oLines = others.map(render).sort((a, b) => a.first - b.first);

fs.writeFileSync(path.join(wd, 'entity-master-persons.md'),
  `# 实体主表·人物\n\n> 由 merge-master.mjs 确定性合并 merge/ 全部中间表（按规范名去重）。共 ${pLines.length} 人。\n\n${pLines.map((x) => x.line).join('\n')}\n`);
fs.writeFileSync(path.join(wd, 'entity-master-others.md'),
  `# 实体主表·地点物品结社\n\n> 由 merge-master.mjs 确定性合并。共 ${oLines.length} 条。\n\n${oLines.map((x) => x.line).join('\n')}\n`);
fs.writeFileSync(path.join(wd, 'entity-master-disputes.md'),
  `# 待仲裁清单（合并自各中间表 + 脚本检测的身份矛盾）\n\n${disputes.join('\n') || '（无）'}\n`);

console.log(JSON.stringify({
  filesRead: fileStats,
  persons: pLines.length,
  others: oLines.length,
  mergedPersons: mergesP,
  mergedOthers: mergesO,
  conflicts: pLines.filter((x) => x.conflicted).length + oLines.filter((x) => x.conflicted).length,
  disputes: disputes.length,
}, null, 2));