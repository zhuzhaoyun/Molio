// orphan-audit.mjs — 孤儿 stub 审计（soft 报告，非门禁）
// 用法: node orphan-audit.mjs [--vault <dir>]
// 对 wiki/ 下所有 stub 页统计"非结构页入度"（排除 INDEX/log/hot 的枚举链接）。
// 入度=0 的 stub 多半是背景语误建页 —— 列出供人工决策，绝不自动删除
//（可能来自还没链接完的半成品）。也报告"仅被其他 stub 互链"的簇。
// 配套判据见 SKILL.md「建页粒度」不建页档。零 LLM，确定性。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const vault = resolveVault(opts);
const wiki = path.join(vault, 'wiki');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
const files = walk(wiki);

const STRUCT = /(^|[\\/])(INDEX|log|hot|todo)\.md$/i;
const isStruct = (f) => STRUCT.test(f);

// 反向链接表 + stub 清单
const linkOf = {};
const stubs = [];
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const isStub = /stub:\s*true/m.test(raw);
  const title = (raw.match(/^title:\s*"?([^"\n]+)"?/m) || [])[1] || path.basename(f).replace(/\.md$/, '');
  const outLinks = [...raw.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
  for (const t of outLinks) (linkOf[t] ||= new Set()).add(f);
  if (isStub && !isStruct(f)) stubs.push({ file: f, title });
}

const orphans = [];
const stubOnly = [];
for (const s of stubs) {
  const sources = new Set([...(linkOf[s.title] || [])].filter((src) => !isStruct(src) && src !== s.file));
  const nonStub = [...sources].filter((src) => !/stub:\s*true/m.test(fs.readFileSync(src, 'utf8')));
  if (sources.size === 0) orphans.push(s);
  else if (nonStub.length === 0) stubOnly.push({ ...s, fromStubs: sources.size });
}

orphans.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
stubOnly.sort((a, b) => a.title.localeCompare(b.title, 'zh'));

console.log(JSON.stringify({
  stubTotal: stubs.length,
  orphanCount: orphans.length,
  orphanOnlyLinkedByStubs: stubOnly.length,
  orphans: orphans.map((s) => ({ title: s.title, rel: path.relative(vault, s.file) })),
  stubOnly: stubOnly.map((s) => ({ title: s.title, fromStubs: s.fromStubs })),
}, null, 2));