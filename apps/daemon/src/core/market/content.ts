// apps/daemon/src/core/market/content.ts
// 商品页结构化内容起草：为「AI 一键配置」补充 content 草稿。
//
// 纪律与 suggest.ts 一致：
// - 只给 agent 知识库的目录结构 + 少量真实正文摘录，不把整个库塞进 prompt；
// - 数量类事实必须能从目录统计核对，条目名必须来自真实文件名；
// - 产物按 cloud/market/service.ts 的校验口径归一（超长截断、缺失必填字段则整段弃用）；
// - AI 只是起草，review.status 固定为 draft，公开页会提示「仍在核对」。
import fs from 'node:fs';
import path from 'node:path';
import type {
  MarketContent, MarketContentDelivery, MarketContentFact, MarketContentPositioning,
  MarketContentQuestion, MarketContentReview, MarketContentSample, MarketContentSeo,
  MarketContentTheme,
} from '@molio/contracts';

const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini']);
const MAX_TREE_GROUPS = 12;
const MAX_GROUP_FILES = 12;
const MAX_OVERVIEW_FILES = 3;
const MAX_OVERVIEW_CHARS = 2400;
const MAX_EXCERPT_FILES = 8;
const MAX_EXCERPT_CHARS = 1200;
const MAX_CONTENT_JSON_BYTES = 60_000;

// 与 apps/cloud/src/market/service.ts 的 MAX_CONTENT_* 同口径。
const MAX_FACTS = 30;
const MAX_THEMES = 30;
const MAX_QUESTIONS = 20;
const MAX_SAMPLES = 10;
const MAX_THEME_ITEMS = 60;

export interface ContentDigest {
  groups: Array<{ dir: string; count: number; files: string[] }>;
  overviews: Array<{ file: string; text: string }>;
  excerpts: Array<{ file: string; text: string }>;
}

const cpLen = (s: string): number => [...s].length;
const cpSlice = (s: string, max: number): string => cpLen(s) <= max ? s : [...s].slice(0, max).join('');

function isExcluded(name: string): boolean {
  return name.startsWith('.') || JUNK_FILES.has(name.toLowerCase());
}

function walk(dir: string, prefix: string, out: string[], allowedTop: Set<string> | null): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (!prefix && allowedTop && !allowedTop.has(entry.name)) continue;
      walk(path.join(dir, entry.name), rel, out, allowedTop);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
    }
  }
}

function readExcerpt(vaultPath: string, rel: string, maxChars: number): string {
  try {
    const text = fs.readFileSync(path.join(vaultPath, rel), 'utf8');
    const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
    return cpSlice(clean, maxChars);
  } catch { return ''; }
}

/** 目录结构（主题候选）+ 总览文件 + 跨目录正文摘录。 */
export function buildContentDigest(vaultPath: string, include?: string[]): ContentDigest {
  const mdFiles: string[] = [];
  const allowedTop = include && include.length > 0 ? new Set(include) : null;
  walk(vaultPath, '', mdFiles, allowedTop);

  const groups = new Map<string, string[]>();
  for (const rel of mdFiles) {
    const parts = rel.split('/');
    // 取前两层：wiki/concepts、wiki/comparisons 这类结构才能真正支撑主题分类。
    const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0]! : '(根目录)';
    const arr = groups.get(dir) ?? [];
    arr.push(rel);
    groups.set(dir, arr);
  }
  const groupRows = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_TREE_GROUPS)
    .map(([dir, files]) => ({
      dir,
      count: files.length,
      files: files.slice(0, MAX_GROUP_FILES).map((f) => f.slice(f.lastIndexOf('/') + 1).replace(/\.md$/i, '')),
    }));

  const rank = (rel: string): number => {
    const base = rel.split('/').pop()!.toLowerCase().replace(/\.md$/, '');
    if (base === 'readme' || base === 'index' || base === 'home') return 0;
    if (/总览|概览|overview|summary/.test(base)) return 1;
    return rel.includes('/') ? 3 : 2;
  };
  const ranked = [...mdFiles].sort((a, b) => rank(a) - rank(b));

  const overviews: Array<{ file: string; text: string }> = [];
  for (const rel of ranked) {
    if (overviews.length >= MAX_OVERVIEW_FILES) break;
    if (rank(rel) > 1) continue;
    const text = readExcerpt(vaultPath, rel, MAX_OVERVIEW_CHARS);
    if (text) overviews.push({ file: rel, text });
  }

  // 每个一级目录取一篇代表正文，避免样例全部来自同一个主题。
  const excerpts: Array<{ file: string; text: string }> = [];
  const seenGroups = new Set<string>();
  for (const rel of ranked) {
    if (excerpts.length >= MAX_EXCERPT_FILES) break;
    if (rank(rel) <= 1) continue;
    const group = rel.includes('/') ? rel.split('/')[0]! : '(根目录)';
    if (seenGroups.has(group)) continue;
    const text = readExcerpt(vaultPath, rel, MAX_EXCERPT_CHARS);
    if (!text) continue;
    seenGroups.add(group);
    excerpts.push({ file: rel, text });
  }
  for (const rel of ranked) {
    if (excerpts.length >= MAX_EXCERPT_FILES) break;
    if (rank(rel) <= 1 || excerpts.some((e) => e.file === rel)) continue;
    const text = readExcerpt(vaultPath, rel, MAX_EXCERPT_CHARS);
    if (text) excerpts.push({ file: rel, text });
  }

  return { groups: groupRows, overviews, excerpts };
}

/** 拼进发布提示词的结构化内容要求（只输出字段说明，不在这里重复 JSON 外壳）。 */
export function contentPromptLines(digest: ContentDigest, today: string): string[] {
  const lines = [
    '',
    '除了上架信息，还要起草商品详情页的结构化内容 content。content 必须全部来自知识库真实内容，不得虚构：',
    '- positioning.what：150-400 字，说明这是什么、整理了哪些资料、与原始资料的区别；可用空行分段',
    '- positioning.who：3-5 条，具体人群与真实使用任务',
    '- positioning.notFor：1-3 条，明确不适合什么，不要贬低',
    '- facts：2-6 条可核对的关键事实（label ≤20 字，value ≤60 字）；数量必须与下方目录统计一致',
    '- themes：按实际内容 2-8 个知识主题（name ≤20 字，summary 40-120 字，items 3-12 个真实条目名，不带 .md）',
    '- questions：2-5 个用户会搜索或问 AI 的知识问题，不是购买/下载 FAQ；question ≤40 字，',
    '  answer 120-500 字、可独立理解，source 写真实来源文件',
    '- samples：1-2 段从正文摘编的真实样例（title ≤30 字，body 150-600 字，source 写来源文件）',
    '- delivery.format 固定写 "Markdown 知识库（.zip）"；includes / requirements / steps 各 2-4 条',
    '- review：{"basis":"根据知识库目录结构与正文摘编整理","reviewedAt":"' + today + '","status":"draft"}',
    '- seo.title ≤40 字，包含资源名与核心主题；seo.description ≤80 字',
    '',
    '目录统计（主题与事实的唯一数量依据）：',
    ...digest.groups.map((g) => '- ' + g.dir + '：' + g.count + ' 篇；条目示例：' + g.files.join('、')),
  ];
  if (digest.overviews.length > 0) {
    lines.push('', '总览文件（用于定位与内容范围）：');
    for (const o of digest.overviews) lines.push('### ' + o.file, o.text);
  }
  if (digest.excerpts.length > 0) {
    lines.push('', '正文摘录（仅用于 questions / samples，摘编时注明来源文件）：');
    for (const e of digest.excerpts) lines.push('### ' + e.file, e.text);
  }
  return lines;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = cpSlice(v.trim(), max);
  return s ? s : null;
}

function strArray(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) {
    const s = str(item, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 归一 AI 输出；必填结构不完整时返回 null（元数据仍可单独使用）。 */
export function normalizeContent(raw: unknown, today = new Date().toISOString().slice(0, 10)): MarketContent | null {
  if (!isRecord(raw) || !isRecord(raw.positioning)) return null;
  const p = raw.positioning;
  const what = str(p.what, 2000);
  if (!what) return null;
  const positioning: MarketContentPositioning = {
    what,
    who: strArray(p.who, 12, 200) ?? [],
    notFor: strArray(p.notFor, 12, 200) ?? [],
  };

  const facts: MarketContentFact[] = [];
  if (Array.isArray(raw.facts)) {
    for (const f of raw.facts) {
      if (!isRecord(f)) continue;
      const label = str(f.label, 40);
      const value = str(f.value, 120);
      if (label && value) facts.push({ label, value });
      if (facts.length >= MAX_FACTS) break;
    }
  }
  if (facts.length === 0) return null;

  const themes: MarketContentTheme[] = [];
  if (Array.isArray(raw.themes)) {
    for (const t of raw.themes) {
      if (!isRecord(t)) continue;
      const name = str(t.name, 80);
      const summary = str(t.summary, 600);
      const items = strArray(t.items, MAX_THEME_ITEMS, 100);
      if (name && summary && items && items.length > 0) themes.push({ name, summary, items });
      if (themes.length >= MAX_THEMES) break;
    }
  }
  if (themes.length === 0) return null;

  const questions: MarketContentQuestion[] = [];
  if (Array.isArray(raw.questions)) {
    for (const q of raw.questions) {
      if (!isRecord(q)) continue;
      const question = str(q.question, 200);
      const answer = str(q.answer, 3000);
      if (!question || !answer) continue;
      const source = str(q.source, 200);
      questions.push(source ? { question, answer, source } : { question, answer });
      if (questions.length >= MAX_QUESTIONS) break;
    }
  }

  const samples: MarketContentSample[] = [];
  if (Array.isArray(raw.samples)) {
    for (const s of raw.samples) {
      if (!isRecord(s)) continue;
      const title = str(s.title, 200);
      const body = str(s.body, 8000);
      if (!title || !body) continue;
      const source = str(s.source, 200);
      samples.push(source ? { title, body, source } : { title, body });
      if (samples.length >= MAX_SAMPLES) break;
    }
  }

  if (!isRecord(raw.delivery)) return null;
  const d = raw.delivery;
  const format = str(d.format, 200);
  if (!format) return null;
  const delivery: MarketContentDelivery = {
    format,
    includes: strArray(d.includes, 30, 300) ?? [],
    requirements: strArray(d.requirements, 30, 300) ?? [],
    steps: strArray(d.steps, 30, 300) ?? [],
  };

  const rawReview = isRecord(raw.review) ? raw.review : {};
  const review: MarketContentReview = {
    basis: str(rawReview.basis, 600) ?? '根据知识库目录结构与正文摘编自动起草，发布前请核对。',
    reviewedAt: str(rawReview.reviewedAt, 40) ?? today,
    status: 'draft',
    autoDrafted: true,
  };

  let seo: MarketContentSeo | undefined;
  if (isRecord(raw.seo)) {
    const title = str(raw.seo.title, 200);
    const description = str(raw.seo.description, 300);
    const aliases = strArray(raw.seo.aliases, 20, 80);
    if (title || description || aliases) {
      seo = {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(aliases && aliases.length > 0 ? { aliases } : {}),
      };
    }
  }

  const content: MarketContent = {
    version: 1,
    positioning,
    facts,
    themes,
    questions,
    ...(samples.length > 0 ? { samples } : {}),
    delivery,
    review,
    ...(seo ? { seo } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_CONTENT_JSON_BYTES) return null;
  return content;
}
