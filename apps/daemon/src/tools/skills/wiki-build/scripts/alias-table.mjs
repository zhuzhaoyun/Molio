// alias-table.mjs — 从 entity-master-persons/others.md 确定性推导 aliases-红楼梦全本.json
// 用法: node alias-table.mjs <stem> [--vault <dir>]
// 规则：
//  - 拆别名、清洗修饰语（本名/小名/自称等前缀、括号附注）
//  - 一个别名只指向一个规范名才入表；多主的歧义别名剔除并报告
//  - EXCLUDE 内的语境称呼（如"二爷"）强制剔除，来自 rules.json: { "alias": { "exclude": [...] } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node alias-table.mjs <stem> [--vault <dir>]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const OUT = path.join(wd, `aliases-${stem}.json`);
const rules = loadRules(vault).alias || {};
const EXCLUDE = new Set(rules.exclude || []);

const owners = new Map(); // alias -> Set(canonical)

function cleanAlias(tok) {
  let t = tok.trim();
  if (!t || t === '无') return null;
  t = t.replace(/[（(][^）)]*[）)]/g, '').trim(); // 去括号附注
  t = t.replace(/^(本名|小名|又名|乳名|绰号|自称|官名)/, '').trim();
  if (/^姓$|^无/.test(t)) return null; // "姓花"之类不是可用称呼
  if (/存疑|[（）()]/.test(t)) return null; // 残留括号/存疑标记的垃圾 token
  if (t.length === 0) return null;
  return t;
}

for (const f of ['entity-master-persons.md', 'entity-master-others.md']) {
  const p = path.join(wd, f);
  if (!fs.existsSync(p)) continue;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const fields = line.slice(2).split('｜').map((x) => x.trim());
    if (fields.length < 2) continue;
    const canonical = fields[0].trim();
    const aliasField = fields[1].replace(/^别名[：:]/, '').trim();
    if (!aliasField || aliasField === '无') continue;
    for (const tok of aliasField.split(/[,，、]/)) {
      const al = cleanAlias(tok);
      if (!al || al === canonical) continue;
      if (EXCLUDE.has(al)) continue;
      if (!owners.has(al)) owners.set(al, new Set());
      owners.get(al).add(canonical);
    }
  }
}

const table = {};
const ambiguous = [];
for (const [al, set] of [...owners.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
  if (set.size === 1) table[al] = [...set][0];
  else ambiguous.push(`${al} → ${[...set].join(' / ')}`);
}

fs.writeFileSync(OUT, JSON.stringify(table, null, 2));
console.log(JSON.stringify({ aliases: Object.keys(table).length, ambiguousDropped: ambiguous }, null, 2));