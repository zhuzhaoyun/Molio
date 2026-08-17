// place.mjs — 安置草稿到 wiki/（按批次 TSV 的页类分发）
//
// 用法:
//   node place.mjs <stem> [--vault <dir>] [--append]
//
// 读取:
//   batches/*.tsv（页类列决定分发目标：entity → wiki/entities/，concept → wiki/concepts/）
//   drafts/*.md（草稿文件）
//
// 模式:
//   默认（build）：全量重写目标目录的 INDEX.md
//   --append（ingest）：只追加新页条目到现有 INDEX.md，不重写既有条目
//
// 零 LLM，确定性。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, resolveVault, buildDir } from './lib/cli.mjs';

const opts = parseArgs(process.argv.slice(2));
const [stem] = opts._;
if (!stem) { console.error('用法: node place.mjs <stem> [--vault <dir>] [--append]'); process.exit(1); }

const vault = resolveVault(opts);
const wd = buildDir(vault);
const draftsDir = path.join(wd, 'drafts');
const batchesDir = path.join(wd, 'batches');
const appendMode = opts._.includes('--append') || process.argv.includes('--append');

// ─── 1. 从批次 TSV 读取页类映射 ───

const pageTypeMap = new Map(); // name -> 'entity' | 'concept'
if (fs.existsSync(batchesDir)) {
  for (const f of fs.readdirSync(batchesDir).filter(f => f.endsWith('.tsv'))) {
    for (const raw of fs.readFileSync(path.join(batchesDir, f), 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length < 5) continue;
      const name = cols[0].trim();
      const pageType = cols[4].trim();
      if (/^页类:\s*concept/.test(pageType)) pageTypeMap.set(name, 'concept');
      else pageTypeMap.set(name, 'entity'); // 默认 entity
    }
  }
}

// ─── 2. 安置草稿 ───

if (!fs.existsSync(draftsDir)) {
  console.error(`drafts 目录不存在: ${draftsDir}`);
  process.exit(1);
}

const drafts = fs.readdirSync(draftsDir).filter(f => f.endsWith('.md'));
const placed = { entity: [], concept: [] };

for (const f of drafts) {
  const name = f.replace(/\.md$/, '');
  const src = path.join(draftsDir, f);
  const type = pageTypeMap.get(name) || 'entity';
  const targetDir = type === 'concept'
    ? path.join(vault, 'wiki', 'concepts')
    : path.join(vault, 'wiki', 'entities');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(src, path.join(targetDir, f));
  placed[type].push(name);
}

// ─── 3. 生成/更新 INDEX ───

function extractSummary(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) continue;
    const m = line.match(/^(.*?[。！？!?])/);
    let summary = (m ? m[1] : line).replace(/\[\[|\]\]/g, '');
    if (summary.length > 60) summary = summary.slice(0, 60) + '…';
    return summary;
  }
  return '（待补摘要）';
}

function buildIndexEntries(names, dir) {
  return names
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map(name => {
      const filePath = path.join(dir, `${name}.md`);
      const summary = fs.existsSync(filePath) ? extractSummary(filePath) : '（待补摘要）';
      return `- [[${name}]] — ${summary}`;
    });
}

function writeIndex(indexPath, title, entries, appendMode) {
  if (appendMode && fs.existsSync(indexPath)) {
    // 追加模式：读取现有 INDEX，只追加新条目（去重）
    const existing = fs.readFileSync(indexPath, 'utf8');
    const existingNames = new Set(
      [...existing.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim())
    );
    const newEntries = entries.filter(e => {
      const name = e.match(/\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/)?.[1]?.trim();
      return name && !existingNames.has(name);
    });
    if (newEntries.length > 0) {
      fs.appendFileSync(indexPath, '\n' + newEntries.join('\n') + '\n');
    }
    return { appended: newEntries.length, skipped: entries.length - newEntries.length };
  } else {
    // 全量重写
    const content = `# ${title}\n\n${entries.join('\n')}\n`;
    fs.writeFileSync(indexPath, content);
    return { written: entries.length };
  }
}

const results = {};
for (const [type, names] of Object.entries(placed)) {
  if (names.length === 0) continue;
  const dir = type === 'concept'
    ? path.join(vault, 'wiki', 'concepts')
    : path.join(vault, 'wiki', 'entities');
  const indexPath = path.join(dir, 'INDEX.md');
  const title = type === 'concept' ? '概念索引' : '实体索引';
  const entries = buildIndexEntries(names, dir);
  results[type] = writeIndex(indexPath, title, entries, appendMode);
}

console.log(JSON.stringify({
  mode: appendMode ? 'append' : 'rewrite',
  placedEntities: placed.entity.length,
  placedConcepts: placed.concept.length,
  indexResults: results,
}, null, 2));