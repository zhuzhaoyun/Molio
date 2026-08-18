// fixfront.mjs — 两处确定性修复：
// 1) frontmatter 内的中文弯引号 “ ” ‘ ’ → ASCII " '（YAML 规范 + 避免 verify 误报）
// 2) 引文行 "> xxx" 去掉 "> " 前缀（verify 对整行块引用会把行号标记一起吃进去导致误报）
// 用法: node fixfront.mjs [--vault <dir>]
// 扫描目录来自 rules.json（默认 wiki/entities, wiki/sources, wiki/concepts）:
//   { "fixfront": { "dirs": ["wiki/entities", "wiki/concepts"] } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const vault = resolveVault(opts);
const rules = loadRules(vault).fixfront || {};
const dirs = (rules.dirs || ['wiki/entities', 'wiki/sources', 'wiki/concepts']).map((d) => path.resolve(vault, d));
let filesFixed = 0;
let fmFixed = 0;
let bqFixed = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, 'utf8');
    let changed = false;
    // 拆 frontmatter
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/);
    let fm = m ? m[1] : null;
    let rest = m ? m[2] : text;
    if (fm) {
      const fixed = fm.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      if (fixed !== fm) { fm = fixed; changed = true; fmFixed++; }
    }
    // blockquote 引文行去前缀（保留内容）
    const restFixed = rest.split(/\r?\n/).map((l) => /^>\s?/.test(l) ? l.replace(/^>\s?/, '') : l).join('\n');
    if (restFixed !== rest) { rest = restFixed; changed = true; bqFixed++; }
    if (changed) {
      fs.writeFileSync(p, (fm !== null ? `---\n${fm}\n---${rest}` : rest));
      filesFixed++;
    }
  }
}
console.log(JSON.stringify({ filesFixed, fmFixed, bqFixed }));