// apps/daemon/test/market-suggest.test.ts
// 发布元数据起草（AI 先写、用户改）：采样/归一/提取的纯逻辑 + 路由接线。
// 真实 agent 调用不在单测范围（见 suggest.ts 的 runner 注入点）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { MARKET_ICONS } from '@molio/contracts';
import { openDatabase } from '../src/core/db.js';
import { marketRoutes } from '../src/routes/market.js';
import {
  appendSearchTermTags,
  buildVaultDigest,
  composeSuggestPrompt,
  extractJson,
  normalizeSuggestion,
  suggestPublishMeta,
} from '../src/core/market/suggest.js';
import { buildContentDigest, normalizeContent } from '../src/core/market/content.js';

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-suggest-vault-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# 红楼梦知识库\n曹雪芹原著整理，含人物关系图谱。', 'utf8');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', '人物.md'), '## 贾宝玉\n荣国府嫡孙。', 'utf8');
  fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2', 'utf8');
  fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.obsidian', 'app.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'Thumbs.db'), 'junk', 'utf8');
  return dir;
}

test('buildVaultDigest：md 优先、隐藏/垃圾文件排除、README 摘录排首', () => {
  const digest = buildVaultDigest(makeVault());
  assert.deepEqual(digest.fileNames, ['README.md', 'notes/人物.md', 'data.csv']);
  assert.ok(!digest.fileNames.some((f) => f.includes('.obsidian') || f.includes('Thumbs.db')));
  assert.equal(digest.snippets[0]?.file, 'README.md');
  assert.ok(digest.snippets[0]?.text.includes('红楼梦'));
});

test('extractJson：容忍围栏与噪声；非法返回 null', () => {
  const fenced = '```json\n{"name":"红楼梦"}\n```';
  assert.deepEqual(extractJson(fenced), { name: '红楼梦' });
  assert.deepEqual(extractJson('好的，结果：{"a":1} 以上'), { a: 1 });
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson('{坏}'), null);
});

test('normalizeSuggestion：截断/去重/白名单/必填校验', () => {
  const longName = '名'.repeat(50);
  const longSummary = '介'.repeat(150);
  const s = normalizeSuggestion({
    name: ` ${longName} `,
    summary: longSummary,
    tags: ['历史', '历史', '文学', '超出两个不要', 42],
    icon: '🚀', // 不在白名单 → 回落默认
  }, 'claude');
  assert.equal([...s.name].length, 30);
  assert.equal([...s.summary].length, 100);
  assert.deepEqual(s.tags, ['历史', '文学']);
  assert.equal(s.icon, MARKET_ICONS[0]);
  assert.equal(s.agentId, 'claude');

  const ok = normalizeSuggestion({ name: '史记', summary: '纪传体通史', tags: ['历史'], icon: '📖' }, 'codex');
  assert.equal(ok.icon, '📖');
  assert.deepEqual(ok.tags, ['历史']);

  assert.throws(() => normalizeSuggestion({ name: '', summary: 'x' }, 'claude'), /suggest_failed/);
  assert.throws(() => normalizeSuggestion({ name: 'x' }, 'claude'), /suggest_failed/);
});

test('normalizeSuggestion：模型自列的检索词补进标签（站外+站内共用）', () => {
  // 标题/简介字数有限，没覆盖到的检索词用标签兜住：标签既上公网页（抓取/结构化数据）
  // 也参与站内逐词 AND 搜索。只补模型自己声明过的词，标签总数不超过云端上限 3。
  const s = normalizeSuggestion({
    queries: ['线性代数', '期末复习', '高数', '微积分'],
    name: '线性代数 期末复习知识库',
    summary: '覆盖同济版全部章节，适合备考',
    tags: ['考研'],
    icon: '📖',
  }, 'claude');
  assert.deepEqual(s.tags, ['考研', '高数', '微积分']);

  // 已被名称/简介覆盖的词不重复补；带空格/超长的检索词放不进单个标签，跳过
  const covered = normalizeSuggestion({
    queries: ['线性代数', '期末 复习', '这是一个非常非常长的检索词'],
    name: '线性代数',
    summary: '适合期末复习',
    tags: [],
    icon: '📖',
  }, 'claude');
  assert.deepEqual(covered.tags, []);

  assert.deepEqual(appendSearchTermTags(['数学'], '线性代数', 'x', ['数学', '高数']), ['数学', '高数']);
  assert.deepEqual(appendSearchTermTags([], 'x', 'y', 'not-an-array'), []);
});

test('composeSuggestPrompt：含清单/摘录/JSON 指令', () => {
  const digest = buildVaultDigest(makeVault());
  const prompt = composeSuggestPrompt(digest);
  assert.ok(prompt.includes('README.md'));
  assert.ok(prompt.includes('内容摘录'));
  assert.ok(prompt.includes('"name"'));
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
  // 检索意图优先（站外：Google/Bing + AI 搜索，不是站内搜索）：
  // 提示词必须要求模型先列 queries，并把「实体正式名 + 可核对数字」写进名称/简介
  // （2026-10 用户反馈：生成的标题简介只像广告语，站外搜不到）。
  assert.ok(prompt.includes('站外'));
  assert.ok(prompt.includes('queries'));
  assert.ok(prompt.includes('检索规则'));
  assert.ok(prompt.includes('可核对的具体事实'));
  const withContent = composeSuggestPrompt(digest, buildContentDigest(makeVault()), '2026-10-27');
  assert.ok(withContent.includes('"content"'));
  assert.ok(withContent.includes('目录统计'));
  assert.ok(withContent.includes('review'));
  assert.ok(withContent.includes('seo.aliases'), '商品页 SEO 也要按检索词给别名');
});

test('buildContentDigest：按一级目录聚合，摘录真实正文且排除隐藏目录', () => {
  const digest = buildContentDigest(makeVault());
  assert.ok(digest.groups.some((g) => g.dir === 'notes' && g.count === 1));
  assert.ok(digest.overviews.some((o) => o.file === 'README.md'));
  assert.ok(digest.excerpts.some((e) => e.file === 'notes/人物.md' && e.text.includes('贾宝玉')));
  assert.ok(!digest.excerpts.some((e) => e.file.includes('.obsidian')));
});

test('buildVaultDigest / buildContentDigest：include 只限制一级目录，根级文件仍随包', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-suggest-scope-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# 根说明', 'utf8');
  fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wiki', 'a.md'), '# A', 'utf8');
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'drafts', 'b.md'), '# B', 'utf8');
  const digest = buildVaultDigest(dir, ['wiki']);
  assert.ok(digest.fileNames.includes('README.md'), '根级文件实际会入包');
  assert.ok(digest.fileNames.includes('wiki/a.md'));
  assert.ok(!digest.fileNames.includes('drafts/b.md'), '未勾选目录不应参与起草');
  const content = buildContentDigest(dir, ['wiki']);
  assert.ok(content.groups.some((g) => g.dir === 'wiki'));
  assert.ok(!content.groups.some((g) => g.dir === 'drafts'));
});

test('normalizeContent：必填结构校验、状态固定 draft、条目超长截断', () => {
  const ok = normalizeContent({
    positioning: { what: '一份红楼梦人物知识库', who: ['研究者'], notFor: ['不是原著全文'] },
    facts: [{ label: '人物页', value: '120 个' }],
    themes: [{ name: '人物关系', summary: '按家族与主仆关系整理', items: ['贾宝玉', '林黛玉'] }],
    questions: [{ question: '宝玉和黛玉是什么关系？', answer: '姑表兄妹。', source: 'notes/人物.md' }],
    samples: [{ title: '贾宝玉', body: '荣国府嫡孙。', source: 'notes/人物.md' }],
    delivery: { format: 'Markdown 知识库（.zip）', includes: ['wiki'], requirements: [], steps: ['解压'] },
    review: { basis: '根据目录整理', reviewedAt: '2026-01-01', status: 'reviewed' },
    seo: { title: '红楼梦人物图谱' },
  }, '2026-10-27');
  assert.ok(ok);
  assert.equal(ok.version, 1);
  assert.equal(ok.review.status, 'draft', 'AI 起草内容不能自称已核对');
  assert.equal(ok.review.autoDrafted, true, 'AI 起草标记用于公开页提示');
  assert.equal(ok.review.reviewedAt, '2026-01-01');
  assert.deepEqual(ok.themes[0]?.items, ['贾宝玉', '林黛玉']);

  assert.equal(normalizeContent({ positioning: { what: 'x' }, facts: [], themes: [] }), null);
  assert.equal(normalizeContent({ positioning: { what: 'x' }, facts: [{ label: 'a', value: 'b' }], themes: [], delivery: { format: 'x' } }), null);
  assert.equal(normalizeContent({ positioning: { what: 'x' }, facts: [{ label: 'a', value: 'b' }], themes: [{ name: 't', summary: 's', items: ['i'] }], delivery: {} }), null);
});

test('suggestPublishMeta：注入 runner 成功路径 + 各类失败归一', async () => {
  const vault = makeVault();
  const pick = () => ({ agentId: 'claude', binary: 'fake' });

  const ok = await suggestPublishMeta(vault, {
    pick,
    runner: async () => '```json\n{"name":"红楼梦","summary":"曹雪芹原著知识库","tags":["文学","经典"],"icon":"📖","content":{"positioning":{"what":"人物知识库","who":["读者"],"notFor":[]},"facts":[{"label":"人物页","value":"1 个"}],"themes":[{"name":"人物","summary":"人物关系","items":["贾宝玉"]}],"questions":[],"delivery":{"format":"Markdown 知识库（.zip）","includes":[],"requirements":[],"steps":[]},"review":{"basis":"目录","reviewedAt":"2026-10-27","status":"draft"}}}\n```',
  });
  assert.equal(ok.name, '红楼梦');
  assert.deepEqual(ok.tags, ['文学', '经典']);
  assert.equal(ok.agentId, 'claude');
  assert.equal(ok.content?.facts[0]?.label, '人物页', 'content 草稿随元数据返回');

  const metaOnly = await suggestPublishMeta(vault, {
    pick,
    runner: async () => '{"name":"红楼梦","summary":"曹雪芹原著知识库","tags":[],"icon":"📖","content":{"bad":true}}',
  });
  assert.equal(metaOnly.name, '红楼梦');
  assert.equal(metaOnly.content, undefined, 'content 非法时只丢内容，不影响元数据');

  await assert.rejects(suggestPublishMeta(vault, { pick: () => null }), /suggest_unavailable/);
  await assert.rejects(suggestPublishMeta(vault, { pick, runner: async () => '我拒绝输出 JSON' }), /suggest_failed/);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-empty-'));
  await assert.rejects(suggestPublishMeta(emptyDir, { pick }), /suggest_failed/);
});

test('publish-suggest 路由：成功回建议；vault 缺失/起草失败各归其码', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const vaultPath = makeVault();
  db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('v1', '测试库', vaultPath, Date.now());
  const suggestion = { name: '红楼梦', summary: '曹雪芹原著知识库', tags: ['文学', '经典'], icon: '📖', agentId: 'claude' };
  const mk = (suggestImpl: (p: string) => Promise<typeof suggestion>) => {
    const app = new Hono();
    app.route('/api/market', marketRoutes(db, { getAccessToken: async () => 'tok' } as never, { fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch, baseUrl: 'https://cloud.local', suggestImpl }));
    return app;
  };
  const post = (app: Hono, body: unknown) => app.request('/api/market/publish-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const res = await post(mk(async () => suggestion), { vaultId: 'v1' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), suggestion);

  assert.equal((await post(mk(async () => suggestion), { vaultId: 'nope' })).status, 400);
  assert.equal((await post(mk(async () => { throw new Error('suggest_unavailable'); }), { vaultId: 'v1' })).status, 503);
  assert.equal((await post(mk(async () => { throw new Error('suggest_timeout'); }), { vaultId: 'v1' })).status, 504);
  const failed = await post(mk(async () => { throw new Error('boom'); }), { vaultId: 'v1' });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'suggest_failed' });
});
