// repair.mjs — 修复 verify 发现的失准引文（恢复逐字原文 / 无据引文去引号转叙述）
// 用法: node repair.mjs [--vault <dir>]
// 同时作用于 wiki/ 与 drafts/（防止安置脚本再次覆盖）
// 修复表来自 rules.json:
//   { "repair": {
//       "repl": [[文件相对路径, 旧串, 新串], ...],
//       "dequote": [[文件相对路径, 无据短语], ...] } }
// drafts 镜像规律：entities/* → .molio/wiki-build/drafts/*，
//                    concepts/* → .molio/wiki-build/drafts-concept/*，
//                    wiki/顶部页 → .molio/wiki-build/drafts-concept/<basename>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const vault = resolveVault(opts);
const wd = buildDir(vault);
const root = vault;
const rules = loadRules(vault).repair || {};
const REPL = rules.repl || [];
const DEQUOTE = rules.dequote || [];

// 镜像返回"相对 vault 根"的路径（.molio/wiki-build/...），applyFile 统一 path.join(root, p) 解析。
// 不要用绝对路径——path.join(root, 绝对路径) 会把绝对路径当相对段拼接成 root/abs（见 wiki-build-pipeline 复盘）。
const draftMirror = (p) => p.startsWith('wiki/entities/') ? path.join('.molio', 'wiki-build', 'drafts', path.basename(p))
  : p.startsWith('wiki/concepts/') ? path.join('.molio', 'wiki-build', 'drafts-concept', path.basename(p))
  : p.startsWith('wiki/') && !p.startsWith('wiki/entities/') && !p.startsWith('wiki/concepts/')
    ? path.join('.molio', 'wiki-build', 'drafts-concept', path.basename(p)) : null;

const report = [];
function applyFile(rel, fn) {
  for (const p of [rel, draftMirror(rel)]) {
    if (!p) continue;
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) continue;
    const before = fs.readFileSync(abs, 'utf8');
    const after = fn(before);
    if (after !== before) { fs.writeFileSync(abs, after); report.push(`changed: ${p}`); }
  }
}

for (const [f, oldS, newS] of REPL) {
  applyFile(f, (t) => t.split(oldS).join(newS));
}
for (const [f, phrase] of DEQUOTE) {
  const re = new RegExp(`["“”]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["“”]`, 'g');
  applyFile(f, (t) => t.replace(re, phrase));
}
console.log(report.join('\n') || '(无变化)');
console.log(`共修改 ${report.length} 个文件`);