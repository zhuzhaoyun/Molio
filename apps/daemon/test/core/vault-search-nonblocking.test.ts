/**
 * 回归：整库索引构建不得独占 daemon 事件循环。
 *
 * 报障（2026-10-16，Windows v0.3.61-beta）：知识库切换不弹新窗口、点「设置」
 * 页面不切换（macOS 同版本正常）。根因：v0.3.61-beta 起 vault 文件 FTS 索引
 * 在启动 sweep / 首搜时全量构建，而那个构建是**同步 walk**——daemon 是单线程，
 * 又同时托管 Web UI 的静态资源（apps/daemon/src/server.ts 的 MOLIO_STATIC_DIR），
 * 实测 5000 文件冷索引独占事件循环 6.3s（Windows 上更长）。此期间连 daemon
 * 自己托管的 chunk 都发不出去：
 *   - 懒路由 /settings 的 chunk 请求挂起 → React 保持旧页面（「点设置不切页」）
 *   - 新窗口 loadURL 挂起 → show:false 的窗口永不显示（「切库不弹新窗口」）
 *
 * 本文件锁死的不变量：**构建期间其它 macrotask / 真实 HTTP 请求必须能插进来，
 * 且能插在「索引还没跑完」的时候**。旧实现（同步 reindexVault）下这两条必红。
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { openDatabase } from '../../src/core/db.js';
import {
  reindexVault, ensureVaultIndexed, hasInflightBuild, rebuildVaultFtsAll,
  searchVaultFiles, VaultIndexSweeper,
} from '../../src/core/vault-search.js';

let vaultDir: string;
let db: ReturnType<typeof openDatabase>;
const V = 'vault-1';
const FILE_COUNT = 120;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsbg-'));
  db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vsbg-db-')));
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(vaultDir, `f${i}.md`), `第${i}号内容标记\n`, 'utf-8');
  }
});

const stateRows = (): number =>
  (db.prepare('SELECT COUNT(*) n FROM vault_files_state WHERE vault_id=?').get(V) as { n: number }).n;

describe('reindexVault 分片让位', () => {
  test('构建期间别的 macrotask 能插进来（且插在索引跑完之前）', async () => {
    const observed: number[] = [];
    // 0ms 定时器 = 「别的 macrotask」探针；观测口径取库里的可见状态（索引进度），
    // 不依赖索引器内部回调。同步 walk 期间探针一次都跑不了。
    const probe = setInterval(() => observed.push(stateRows()), 0);
    try {
      await reindexVault(db, V, vaultDir, { yieldEvery: 5 });
    } finally {
      clearInterval(probe);
    }
    assert.equal(stateRows(), FILE_COUNT, '整库都该被索引');
    assert.ok(
      observed.some((n) => n > 0 && n < FILE_COUNT),
      `构建中途必须有 macrotask 插进来——同步 walk 会独占事件循环（实际观测 ${JSON.stringify(observed)}）`,
    );
  });

  test('构建期间真实 HTTP 请求照常被响应（/api/health 探针）', async () => {
    const app = new Hono();
    app.get('/api/health', (c) => c.json({ ok: true }));
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const build = reindexVault(db, V, vaultDir, { yieldEvery: 1 });
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const rowsAtResponse = stateRows();
      assert.equal(res.status, 200);
      await build;
      assert.equal(stateRows(), FILE_COUNT);
      assert.ok(
        rowsAtResponse > 0 && rowsAtResponse < FILE_COUNT,
        `健康检查必须在索引跑完之前返回（返回时已索引 ${rowsAtResponse}/${FILE_COUNT}）`
          + '——用户报障的「点设置不切页」就是静态资源请求被构建挡住',
      );
    } finally {
      // undici 的 keep-alive 连接会让裸 close() 一直等——先掐连接再关。
      // serve() 的返回类型是 http/https/http2 联合，取本用例实际拿到的 http.Server 形状。
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close();
    }
  });

  test('shouldStop 后立刻收工，不拖着跑完整库（daemon 关停路径）', async () => {
    await reindexVault(db, V, vaultDir, { yieldEvery: 5, shouldStop: () => stateRows() >= 10 });
    const rows = stateRows();
    assert.ok(rows >= 10, `至少跑到关停点，实际 ${rows}`);
    assert.ok(rows < FILE_COUNT, `关停后必须提前收工，实际跑完 ${rows}/${FILE_COUNT}`);
  });

  test('已删除文件在收尾批次里清除（批量事务不改变行为）', async () => {
    await reindexVault(db, V, vaultDir);
    assert.equal(stateRows(), FILE_COUNT);
    for (let i = 0; i < FILE_COUNT - 1; i++) fs.unlinkSync(path.join(vaultDir, `f${i}.md`));
    const r = await reindexVault(db, V, vaultDir);
    assert.equal(r.removed, FILE_COUNT - 1);
    assert.equal(stateRows(), 1);
  });
});

describe('同一 vault 的构建去重（分片后并发才可能出现）', () => {
  test('并发入口共享同一次构建（首搜建库 / sweep / 启动预索引三路并发）', async () => {
    const a = ensureVaultIndexed(db, V, vaultDir);
    const b = ensureVaultIndexed(db, V, vaultDir);
    assert.equal(a, b, '第二次调用必须复用 in-flight 构建，而不是再 walk 一遍');
    await a;
    assert.equal(stateRows(), FILE_COUNT);
  });

  test('构建期间的搜索等到完整索引，不读半成品（静默漏结果的窗口）', async () => {
    const build = ensureVaultIndexed(db, V, vaultDir, { yieldEvery: 1 });
    const mid = stateRows();
    assert.ok(mid > 0 && mid < FILE_COUNT, `应停在构建中途才能验到该窗口（实际 ${mid}/${FILE_COUNT}）`);
    const { results } = await searchVaultFiles(db, V, vaultDir, '内容标记', FILE_COUNT + 1);
    assert.equal(
      results.length,
      FILE_COUNT,
      '搜索必须等完整构建——半成品索引里 seeded 判据已通过，只查已索引的那部分会静默漏结果',
    );
    await build;
  });
});

describe('VaultIndexSweeper 并发去重', () => {
  test('同 vault 并发 sweep 复用同一个 in-flight promise，不重复 walk', async () => {
    db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?,?,?,?)')
      .run(V, '库', vaultDir, Date.now());
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    const first = sw.sweepVaultNow(V);
    const second = sw.sweepVaultNow(V);
    assert.equal(first, second, '第二个调用必须复用 in-flight promise（分片异步后同一 vault 可能被并发触发）');
    await first;
    assert.equal(stateRows(), FILE_COUNT);
    sw.stop();
  });

  test('stop 后 sweepVaultNow 不再起新构建（关停竞态：别在已关的库上 walk）', async () => {
    db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?,?,?,?)')
      .run(V, '库', vaultDir, Date.now());
    const sw = new VaultIndexSweeper(db, { debounceMs: 20 });
    sw.stop();
    const p = sw.sweepVaultNow(V);
    // 关键在「有没有登记一次构建」，不在最终行数：即便起了新构建，shouldStop 也会
    // 在头一个文件前掐断（行数同样是 0），但那次 walk 会碰已 close 的库/已停的服务。
    assert.equal(hasInflightBuild(db, V), undefined, '关停后不得再登记构建');
    await p;
    assert.equal(stateRows(), 0);
  });
});

describe('改名 / 灾难恢复重建：同样走单行道', () => {
  test('等完在跑的构建后，下一次调用必须是一次新构建（不是并入旧的）', async () => {
    // routes/knowledge.ts 目录改名分支依赖这一点：只并入在跑的构建，可能拿不到
    // 「起点在改名之后」的那次 walk，改名的子树就没人走。
    const inflight = ensureVaultIndexed(db, V, vaultDir, { yieldEvery: 1 });
    assert.ok(stateRows() > 0 && stateRows() < FILE_COUNT, '得停在构建中途才验得到');
    await hasInflightBuild(db, V); // 路线里的「先等在跑的收工」
    const after = ensureVaultIndexed(db, V, vaultDir);
    assert.notEqual(after, inflight, '等完后必须是新登记的一次构建——并入旧构建等于改名后的树没被 walk');
    await after;
    assert.equal(stateRows(), FILE_COUNT);
  });

  test('灾难恢复重建不与在跑的构建并行（清表必须等它收工）', async () => {
    db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?,?,?,?)')
      .run(V, '库', vaultDir, Date.now());
    const inflight = ensureVaultIndexed(db, V, vaultDir, { yieldEvery: 1 });
    const progress = stateRows();
    assert.ok(progress > 0 && progress < FILE_COUNT, `得停在构建中途才验得到（实际 ${progress}）`);

    // 注意不 await：清表若此刻发生，正在跑的 walk 已经走过的文件不会回头重读
    //（影子表已空、seen 已前进）→ 最终索引残缺。
    const rebuild = rebuildVaultFtsAll(db);
    assert.equal(stateRows(), progress, '在跑的构建没结束前不得清空索引');
    const { vaults } = await rebuild;
    assert.equal(vaults, 1);
    await inflight;
    assert.equal(stateRows(), FILE_COUNT);
    const { results } = await searchVaultFiles(db, V, vaultDir, '内容标记', FILE_COUNT + 1);
    assert.equal(results.length, FILE_COUNT, '重建后索引必须完整');
  });
});
