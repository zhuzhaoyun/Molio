// lib/cli.mjs — shared CLI parsing + vault/workdir resolution for wiki-build scripts.
//
// Convention (same shape as prep.mjs):
//   --vault <dir>   vault root (where wiki/ lives). Defaults to process.cwd().
//   --force         overwrite existing non-resumable artifacts
//   --help / -h
//   positionals     web first positional is the "stem" (source file stem) when the
//                   script needs to address build artifacts per-source-file.
//
// Build workdir (shared state between all wiki-build scripts):
//   <vault>/.molio/wiki-build/
//
// Rules file (corpus-specific human tables):
//   <vault>/.molio/wiki-build/rules.json   — optional. shape:
//     {
//       "merge": { "preferredCanon": ["巧姐"], "extraMerges": {"巧姐儿": "巧姐"} },
//       "alias": { "exclude": ["二爷", "老爷"] },
//       "repair": { "repl": [["wiki/xxx.md","old","new"]], "dequote": [["wiki/xxx.md","phrase"]] },
//       "indexSections": { "others": "地点物品结社" }   // place.mjs classification
//     }
//   Absent = empty rules (scripts are no-ops where rules were the only input).

import fs from 'node:fs';
import path from 'node:path';

export function parseArgs(argv) {
  const opts = { _: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

/** Resolve vault root: --vault wins, else cwd (agent usually runs from vault root). */
export function resolveVault(opts) {
  return path.resolve(opts.vault || process.cwd());
}

/** Build workdir shared by all wiki-build scripts. */
export function buildDir(vault) {
  return path.join(vault, '.molio', 'wiki-build');
}

/** Read optional corpus rules; returns {} when absent. Throws on malformed JSON. */
export function loadRules(vault) {
  const file = path.join(buildDir(vault), 'rules.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(`rules.json is not valid JSON (${file}): ${e.message}`), { exitCode: 3 });
  }
}

/** Common usage printer for the build scripts. */
export function usage(name, lines) {
  process.stderr.write([`Usage: node ${name}.mjs ${lines.join(' | ')}`, '', '  --vault <dir>    vault root (default: cwd)', '  --force          overwrite existing artifacts', '  --help           this message', ''].join('\n'));
}

/**
 * 清洗别名 token：返回 null 表示该 token 不应作为别名（噪音/自名/单字/占位）。
 * 两个调用方必须用同一规则，否则 curation 预填的别名 linkpass 里再次校验会不一致：
 *   curate.mjs draft 预填时
 *   linkpass.mjs --batches 读取批次别名列时
 * 规则（按序返回 null）：
 *   - 空串 / "无" / "-" / "—" / "N/A"
 *   - 含 "[[" / "]]"（链接语法混入）
 *   - 等于 canonical 自身（自名）
 *   - 单字（len<=1，语义错链风险高；如复盘的"赵"级单字大量错链）
 *   - 含 / 或 、（未拆干净的多别名，调用方应预先 split）
 */
export function cleanAliasToken(alias, canonical) {
  const a = (alias || '').trim();
  if (!a) return null;
  if (a === '无' || a === '-' || a === '—' || a === 'N/A' || a === '无') return null;
  if (a.includes('[[') || a.includes(']]')) return null;
  if (canonical && a === canonical.trim()) return null;
  if (a.length <= 1) return null; // 单字别名：语义错链风险高，宁缺勿错
  if (/[/、,，]/.test(a)) return null; // 未拆干净的多别名
  return a;
}