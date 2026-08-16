// place.mjs — 安置草稿：drafts/*.md → wiki/entities/，并生成 wiki/entities/INDEX.md
// 用法: node place.mjs <stem> [--vault <dir>]
// 摘要提取：stub 取正文首行；完整页取 frontmatter 后首个非标题段的第一句
// 归类：以 manifest 的"地点物品结社"名单为依据（不依赖页面 tags 措辞）；
//       小节标题可经 rules.json 覆盖: { "indexSections": { "others": "地点物品结社" } }
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir, loadRules } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node place.mjs <stem> [--vault <dir>]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const draftsDir = path.join(wd, 'drafts');
const entDir = path.join(vault, 'wiki', 'entities');
const rules = loadRules(vault);
const OTHERS_HEADING = rules.indexSections?.others ?? '地点物品结社';
const VBOOK = rules.indexSections?.vaultLabel ?? '红楼梦'; // INDEX 头部显示的库名

fs.mkdirSync(entDir, { recursive: true });

// 以 manifest 的地点物品结社名单为归类依据（不依赖页面 tags 措辞）
const manifestText = fs.readFileSync(path.join(wd, `page-manifest-${stem}.md`), 'utf8');
const re = new RegExp(`^##\\s*${OTHERS_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
const othersSection = (manifestText.split(re)[1] || '');
const othersSet = new Set(othersSection.split(/\r?\n/).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split('｜')[0].trim()));

const drafts = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.md'));
const persons = [];
const others = [];
let placed = 0;

for (const f of drafts) {
  const src = path.join(draftsDir, f);
  const text = fs.readFileSync(src, 'utf8');
  // 提取摘要
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  let summary = '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    const m = line.match(/^(.*?[。！？!?])/);
    summary = (m ? m[1] : line).replace(/\[\[|\]\]/g, '');
    if (summary.length > 60) summary = summary.slice(0, 60) + '…';
    break;
  }
  if (!summary) summary = '（待补摘要）';
  const name = f.replace(/\.md$/, '');
  const isStub = /^stub:\s*true/m.test(text);
  const isOther = othersSet.has(name);
  const dest = path.join(entDir, f);
  fs.copyFileSync(src, dest);
  placed++;
  (isOther ? others : persons).push({ name, summary, isStub });
}

function section(title, list) {
  const full = list.filter((x) => !x.isStub).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const stubs = list.filter((x) => x.isStub).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  let out = `## ${title}\n\n`;
  if (full.length) {
    out += `### 完整页（${full.length}）\n\n` + full.map((x) => `- [[${x.name}]] — ${x.summary}`).join('\n') + '\n\n';
  }
  if (stubs.length) {
    out += `### stub（${stubs.length}）\n\n` + stubs.map((x) => `- [[${x.name}]] — ${x.summary}`).join('\n') + '\n';
  }
  return out;
}

const index = `# 实体索引

> 《${VBOOK}》人物 ${persons.length} 页（完整 ${persons.filter((x) => !x.isStub).length} / stub ${persons.filter((x) => x.isStub).length}），地点物品结社 ${others.length} 页（完整 ${others.filter((x) => !x.isStub).length} / stub ${others.filter((x) => x.isStub).length}）。

${section('人物', persons)}
${section('地点·物品·结社', others)}`;

fs.writeFileSync(path.join(entDir, 'INDEX.md'), index);
console.log(JSON.stringify({ placed, persons: persons.length, others: others.length }));