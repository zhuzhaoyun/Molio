// fixfront.mjs — 两处确定性修复：
// 1) frontmatter 内的中文弯引号 “ ” ‘ ’ → ASCII " '（YAML 规范 + 避免 verify 误报）
// 2) 引文行 "> xxx" 去掉 "> " 前缀（verify 对整行块引用会把行号标记一起吃进去导致误报）
// 用法: node fixfront.mjs [--vault <dir>]
// 扫描目录来自 rules.json（默认 wiki/entities, wiki/sources, wiki/concepts）:
//   { "fixfront": { "dirs": ["wiki/entities", "wiki/concepts"] } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, loadRules } from './lib/cli.mjs';
import { frontmatterEnd } from './lib/linktext.mjs';

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
    // 拆 frontmatter —— 判定与 linkpass/deadcheck 共用 lib/linktext.mjs 的
    // frontmatterEnd()，不再自持一份正则（三个脚本对「什么是 frontmatter」
    // 各判各的，正是门禁与工具行为漂移的起点）。收敛顺带修掉旧正则的三处偏差：
    // `--- ` 尾随空白不再漏判；文件正好结束在闭合 `---` 的 frontmatter 不再
    // 漏判；分隔符行尾原样保留（旧版重建时会把 `---` 的 CRLF 强转 LF）。
    const fmEnd = frontmatterEnd(text);
    let fm = fmEnd > 0 ? text.slice(0, fmEnd) : null;
    let rest = fm !== null ? text.slice(fmEnd) : text;
    if (fm !== null) {
      const fixed = fm.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      if (fixed !== fm) { fm = fixed; changed = true; fmFixed++; }
    }
    // blockquote 引文行去前缀（保留内容）。分隔符留在 split 结果里（捕获组），
    // 行尾 CRLF/LF 原样保留——旧的 split+join('\n') 会把没动过的行也强转 LF。
    const restParts = rest.split(/(\r?\n)/);
    let strippedAny = false;
    for (let i = 0; i < restParts.length; i += 2) {
      const l = restParts[i];
      if (l === undefined || !/^>\s?/.test(l)) continue;
      restParts[i] = l.replace(/^>\s?/, '');
      strippedAny = true;
    }
    if (strippedAny) { rest = restParts.join(''); changed = true; bqFixed++; }
    if (changed) {
      fs.writeFileSync(p, (fm !== null ? fm + rest : rest));
      filesFixed++;
    }
  }
}
console.log(JSON.stringify({ filesFixed, fmFixed, bqFixed }));
