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
  buildVaultDigest,
  composeSuggestPrompt,
  extractJson,
  normalizeSuggestion,
  suggestPublishMeta,
} from '../src/core/market/suggest.js';

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

test('composeSuggestPrompt：含清单/摘录/JSON 指令', () => {
  const digest = buildVaultDigest(makeVault());
  const prompt = composeSuggestPrompt(digest);
  assert.ok(prompt.includes('README.md'));
  assert.ok(prompt.includes('内容摘录'));
  assert.ok(prompt.includes('"name"'));
  assert.ok(prompt.includes('只输出一个 JSON 对象'));
});

test('suggestPublishMeta：注入 runner 成功路径 + 各类失败归一', async () => {
  const vault = makeVault();
  const pick = () => ({ agentId: 'claude', binary: 'fake' });

  const ok = await suggestPublishMeta(vault, {
    pick,
    runner: async () => '```json\n{"name":"红楼梦","summary":"曹雪芹原著知识库","tags":["文学","经典"],"icon":"📖"}\n```',
  });
  assert.equal(ok.name, '红楼梦');
  assert.deepEqual(ok.tags, ['文学', '经典']);
  assert.equal(ok.agentId, 'claude');

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