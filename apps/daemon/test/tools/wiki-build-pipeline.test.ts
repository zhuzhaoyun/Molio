import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for the parameterized wiki-build pipeline CLIs — the
 * deterministic stage scripts that were hand-specialized for the 红楼梦
 * rebuild and are now productized (parameterized via <stem> + --vault,
 * with corpus-specific human tables moved out of code into rules.json).
 *
 * Regression locks for real build bugs:
 *   1. build-lock relied on PID liveness — but every CLI call is a short-lived
 *      process, so the first acquirer's PID is already dead when a concurrent
 *      session calls acquire; the second session would take over the lock as
 *      "stale" (双会话撞车). Ownership is now label-declared.
 *   2. batcher/merge/alias used hard-coded 红楼梦全本 filenames — they would
 *      fail on any other corpus. All read from <vault>/.molio/wiki-build/.
 *   3. checkoff existed only as "tick all checkboxes" — stage gates (L2a/L2b
 *      artifact completeness) are new; missing artifacts must exit 1.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveScript(name: string): string {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', name),
    path.join(__dirname, '..', '..', 'src', 'tools', 'skills', 'wiki-build', 'scripts', name),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`script not found: ${name}`);
}

const stem = '测试源';
let vault: string; // temp vault root
let wd: string;    // vault/.molio/wiki-build

function run(name: string, args: string[], opts: { expectExit?: number } = {}): { status: number; stdout: string; stderr: string } {
  const out = spawnSync('node', [resolveScript(name), ...args, '--vault', vault], { encoding: 'utf8' });
  if (opts.expectExit !== undefined) assert.strictEqual(out.status, opts.expectExit, `${name} stderr: ${out.stderr}`);
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

/** mkdir -p */
function mk(p: string) { fs.mkdirSync(p, { recursive: true }); }

before(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-build-pipeline-'));
  wd = path.join(vault, '.molio', 'wiki-build');
  mk(wd);
  mk(path.join(wd, 'merge'));
  mk(path.join(wd, 'drafts'));
  mk(path.join(vault, 'wiki', 'entities'));
});

after(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

// ── fixture: minimal two-category manifest ──
function writeManifest(pages: Array<[string, string]>) {
  const lines = pages.map(([name, tier]) => `- ${name}｜${tier}｜desc`).join('\n');
  fs.writeFileSync(path.join(wd, `page-manifest-${stem}.md`), `# 页面清单\n\n${lines}\n`);
}

// ─── batcher ───

describe('batcher.mjs（参数化分片）', () => {
  before(() => {
    // 23 full + 4 stub，批次 8/5
    const full = Array.from({ length: 23 }, (_, i) => `F${i + 1}`);
    const stub = Array.from({ length: 4 }, (_, i) => `S${i + 1}`);
    writeManifest([...full.map((n) => [n, '完整页'] as [string, string]), ...stub.map((n) => [n, 'stub'] as [string, string])]);
    fs.writeFileSync(path.join(wd, 'rules.json'), JSON.stringify({ batch: { full: 8, stub: 5 } }));
  });

  it('按 stem 读 manifest 并分片', () => {
    const r = run('batcher.mjs', [stem], { expectExit: 0 });
    const meta = JSON.parse(r.stdout);
    assert.strictEqual(meta.full, 23);
    assert.strictEqual(meta.stub, 4);
    // 23/8 = 3 批；4/5 = 1 批
    assert.strictEqual(meta.fullBatches, 3);
    assert.strictEqual(meta.stubBatches, 1);
    const first = fs.readFileSync(path.join(wd, 'batches', 'batch-full-01.list'), 'utf8').trim().split('\n');
    assert.strictEqual(first.length, 8);
    assert.deepStrictEqual(first, Array.from({ length: 8 }, (_, i) => `F${i + 1}`));
  });

  it('缺 manifest 时报错 exit 1', () => {
    const r = run('batcher.mjs', ['不存在'], { expectExit: 1 });
    assert.match(r.stderr, /manifest 不存在/);
  });
});

// ─── merge-master + alias-table ───

describe('merge-master.mjs + alias-table.mjs（参数化确定性合并）', () => {
  before(() => {
    // 两张 merge 切片：同一实体两条记录（别名互指 → 应归并），一个歧义别名
    fs.writeFileSync(path.join(wd, 'merge', 'M1.md'), [
      '## 人物',
      '- 贾宝玉｜别名：宝玉,宝二爷｜身份：荣府公子｜分布：R001,R002｜首现：L100',
      '- 黛玉｜别名：林黛玉｜身份：姑苏闺秀｜分布：R001｜首现：L120',
    ].join('\n'));
    fs.writeFileSync(path.join(wd, 'merge', 'M2.md'), [
      '## 人物',
      '- 林黛玉｜别名：黛玉｜身份：绛珠仙子｜分布：R002,R003｜首现：L121',
      '- 宝玉｜别名：贾宝玉｜身份：神瑛侍者｜分布：R003｜首现：L99',
      '- 林妹｜别名：林黛玉｜身份：姑苏闺秀｜分布：R001｜首现：L130',  // EXTRA_MERGE 入口：归并入 林黛玉
    ].join('\n'));
    fs.writeFileSync(path.join(wd, 'rules.json'), JSON.stringify({
      merge: { preferredCanon: ['林黛玉'], extraMerges: { '林妹': '林黛玉' } },
      alias: { exclude: ['宝二爷'] },
    }));
  });

  it('跨切片归并同一实体、长名保留优先名单例外', () => {
    const r = run('merge-master.mjs', [], { expectExit: 0 });
    const meta = JSON.parse(r.stdout);
    // 贾宝玉 + 宝玉 → 1；黛玉 + 林黛玉 + 林妹 → 林黛玉（preferredCanon 例外）→ 1，共 2 人
    assert.strictEqual(meta.persons, 2);
    const text = fs.readFileSync(path.join(wd, 'entity-master-persons.md'), 'utf8');
    assert.match(text, /^- 贾宝玉｜/m);
    assert.match(text, /^- 林黛玉｜/m);
    assert.ok(!/^- 黛玉｜/m.test(text), '黛玉 应被归并进 林黛玉');
    assert.ok(!/^- 林妹｜/m.test(text), '林妹 应经 EXTRA_MERGE 归并进 林黛玉');
  });

  it('aliases 确定性推导：歧义剔除、EXCLUDE 剔除、extraMerges 生效', () => {
    run('alias-table.mjs', [stem], { expectExit: 0 });
    const table = JSON.parse(fs.readFileSync(path.join(wd, `aliases-${stem}.json`), 'utf8'));
    // 宝玉 → 贾宝玉 唯一指向入表；宝二爷被 EXCLUDE；黛玉 归并进 林黛玉（入林黛玉的别名集）
    assert.strictEqual(table['宝玉'], '贾宝玉');
    assert.ok(!('宝二爷' in table), 'EXCLUDE 中的宝二爷不应入表');
    assert.strictEqual(table['黛玉'], '林黛玉');
  });
});

// ─── checkoff ───

describe('checkoff.mjs（打勾 + G1/G2 产物门禁）', () => {
  it('gate-l2a：缺 master 表 → exit 1', () => {
    writeManifest([['F1', '完整页']]);
    // 清掉 merge 测试遗留的 master 文件，模拟真缺
    for (const f of ['entity-master-persons.md', 'entity-master-others.md', 'entity-master-disputes.md']) {
      fs.rmSync(path.join(wd, f), { force: true });
    }
    const r = run('checkoff.mjs', [stem, 'gate-l2a'], { expectExit: 1 });
    assert.match(r.stderr, /缺失 entity-master-persons\.md/);
  });

  it('gate-l2a：master 表覆盖不齐（>5%）→ exit 1', () => {
    fs.writeFileSync(path.join(wd, 'entity-master-persons.md'), '# 实体主表·人物\n\n- 他人｜别名：无｜身份：x｜分布：R001｜首现：L1\n');
    fs.writeFileSync(path.join(wd, 'entity-master-others.md'), '# 实体主表·地点物品结社\n\n- 他物｜别名：无｜身份：y｜分布：R001｜首现：L2\n');
    fs.writeFileSync(path.join(wd, 'entity-master-disputes.md'), '# 待仲裁\n\n（无）\n');
    fs.writeFileSync(path.join(wd, `aliases-${stem}.json`), JSON.stringify({ 别的: '他人' }));
    // manifest：F1 完整页 + 另 20 个 stub，master 全缺 → 覆盖率 ~5% 以下必然超
    const stubs: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [`S${i}`, 'stub']);
    writeManifest([['F1', '完整页'], ...stubs]);
    const r = run('checkoff.mjs', [stem, 'gate-l2a'], { expectExit: 1 });
    assert.match(r.stderr, /master 表缺 21\/21/);
  });

  it('gate-l2b：缺页面 → exit 1 并列出', () => {
    fs.writeFileSync(path.join(vault, 'wiki', 'entities', 'F1.md'), '# F1\n');
    const r = run('checkoff.mjs', [stem, 'gate-l2b'], { expectExit: 1 });
    assert.match(r.stderr, /L2b 缺/);
    assert.match(r.stderr, /S0/);
  });

  it('gate-l2b：齐全 → exit 0', () => {
    // 重建 manifest：只有 F1（F1 文件已存在于上个测试）
    writeManifest([['F1', '完整页']]);
    const r = run('checkoff.mjs', [stem, 'gate-l2b'], { expectExit: 0 });
    assert.match(r.stdout, /"pass":true/);
  });

  it('checkoff（无 gate 参数）默认打勾，幂等', () => {
    fs.writeFileSync(path.join(wd, `candidates-${stem}.md`), '# 候选实体\n\n- [ ] 甲\n- [ ] 乙\n');
    run('checkoff.mjs', [stem], { expectExit: 0 });
    run('checkoff.mjs', [stem], { expectExit: 0 }); // 第二遍无变化
    const text = fs.readFileSync(path.join(wd, `candidates-${stem}.md`), 'utf8');
    assert.ok(!/^- \[ \]/.test(text), '所有 checkbox 应已勾选');
  });
});

// ─── build-lock ───

describe('build-lock.mjs（label 声明式双会话锁）', () => {
  after(() => { fs.rmSync(path.join(wd, 'LOCK'), { force: true }); });

  it('acquire 立锁 → 异 label 拒绝 → 同 label 重入幂等 → release 正常', () => {
    const a1 = run('build-lock.mjs', ['acquire', 'buildA'], { expectExit: 0 });
    assert.strictEqual(JSON.parse(a1.stdout).replacedStale, false);

    const a2 = run('build-lock.mjs', ['acquire', 'buildB'], { expectExit: 1 });
    assert.match(a2.stderr, /构建被占用/);

    const a3 = run('build-lock.mjs', ['acquire', 'buildA'], { expectExit: 0 }); // 重入
    assert.strictEqual(JSON.parse(a3.stdout).replacedStale, false);

    const r1 = run('build-lock.mjs', ['release', 'buildB'], { expectExit: 1 }); // 异 label 不许删
    assert.match(r1.stderr, /无权代删/);

    const r2 = run('build-lock.mjs', ['release', 'buildA'], { expectExit: 0 });
    assert.strictEqual(JSON.parse(r2.stdout).released, true);

    const status = run('build-lock.mjs', ['status'], { expectExit: 0 });
    assert.strictEqual(JSON.parse(status.stdout), null); // 锁已删
  });
});