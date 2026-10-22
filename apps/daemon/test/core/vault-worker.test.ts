import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { VaultWorkerClient, resolveWorkerEntryUrl } from '../../src/core/vault-worker.js';
import { buildGraph } from '../../src/core/graph-build.js';
import type { GraphData, TreeNode } from '@molio/contracts';

/**
 * worker 线程客户端（core/vault-worker.ts）。
 *
 * 要钉死的是三件在请求线程上做不到的事：
 * 1. 结果与进程内实现完全一致（worker 只是换了个线程，不是换了一套逻辑）；
 * 2. **构建期间父进程的事件循环是活的**——这正是这一步优化的全部意义；
 * 3. 线程崩溃 / 任务超时都不留下坏状态：在途请求 reject，下一次请求自动重建线程。
 */

const dirs: string[] = [];

function makeVault(...files: Array<[rel: string, content: string]>): string {
  const d = mkdtempSync(join(tmpdir(), 'molio-vault-worker-'));
  dirs.push(d);
  for (const [rel, content] of files) {
    const abs = join(d, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, { encoding: 'utf-8' });
  }
  return d;
}

const clients: VaultWorkerClient[] = [];
function makeClient(timeoutMs?: number): VaultWorkerClient {
  const c = timeoutMs === undefined ? new VaultWorkerClient() : new VaultWorkerClient(timeoutMs);
  clients.push(c);
  return c;
}

after(() => {
  for (const c of clients) c.dispose();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('VaultWorkerClient', () => {
  it('入口文件能在当前运行形态下解析出来（dist .js / tsx .ts / 桌面 .mjs）', () => {
    const url = resolveWorkerEntryUrl();
    assert.match(url.pathname, /vault-worker-entry\.(js|ts|mjs)$/);
  });

  it('graph 任务的结果与同步 buildGraph 完全一致', async () => {
    const vault = makeVault(
      ['a.md', '---\ntype: concept\n---\n\n# A\n\n[[b]]\n'],
      ['b.md', '# B\n\n[[ghost]]\n'],
      ['dir/c.md', '# C\n\n[[a]]\n'],
    );

    const viaWorker = await makeClient().request<GraphData>({ kind: 'graph', vaultPath: vault });
    assert.deepEqual(viaWorker, buildGraph(vault));
  });

  it('tree 任务返回 scanTree 的结果（含子目录）', async () => {
    const vault = makeVault(['a.md', '# A\n'], ['dir/b.md', '# B\n']);
    const tree = await makeClient().request<TreeNode[]>({ kind: 'tree', vaultPath: vault });

    assert.deepEqual(tree.map((n) => n.name).sort(), ['a.md', 'dir']);
    const dir = tree.find((n) => n.name === 'dir');
    assert.deepEqual(dir?.children?.map((n) => n.name), ['b.md']);
  });

  it('构建期间父进程事件循环不被阻塞（扫描挪出请求线程的意义）', async () => {
    const vault = makeVault(['a.md', '# A\n']);
    const client = makeClient();

    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 20);
    try {
      // __testBlockMs 让 worker 空转 300ms（模拟真实大库的同步扫描）
      const graph = await client.request<GraphData>({ kind: 'graph', vaultPath: vault, __testBlockMs: 300 });
      assert.equal(graph.nodes.length, 1);
    } finally {
      clearInterval(interval);
    }

    // 300ms / 20ms ≈ 15 拍；留足余量只要求「明显在跑」。同步实现这里会是 0。
    assert.ok(ticks >= 5, `构建期间事件循环被阻塞了（20ms 定时器只跑了 ${ticks} 拍）`);
  });

  it('线程崩溃：在途请求 reject，下一次请求自动重建线程', async () => {
    const client = makeClient();
    await assert.rejects(client.request({ kind: '__test-crash' }), /crashed|exited/);

    const vault = makeVault(['after-crash.md', '# ok\n']);
    const graph = await client.request<GraphData>({ kind: 'graph', vaultPath: vault });
    assert.deepEqual(graph.nodes.map((n) => n.key), ['after-crash.md']);
  });

  it('任务超时：reject 掉卡住的任务，下一次请求换新线程照常工作', async () => {
    // 超时放 500ms：卡住的任务永不回包，等满即判定；余量要够慢机器重建线程
    // （新线程启动 + 扫一个单文件库）不被误判成又超时。
    const client = makeClient(500);
    await assert.rejects(client.request({ kind: '__test-hang' }), /timed out/);

    const vault = makeVault(['after-timeout.md', '# ok\n']);
    const graph = await client.request<GraphData>({ kind: 'graph', vaultPath: vault });
    assert.deepEqual(graph.nodes.map((n) => n.key), ['after-timeout.md']);
  });

  it('同一线程上的并发任务都能拿到各自的结果', async () => {
    const v1 = makeVault(['one.md', '# 1\n']);
    const v2 = makeVault(['two.md', '# 2\n']);
    const client = makeClient();

    const [g1, g2] = await Promise.all([
      client.request<GraphData>({ kind: 'graph', vaultPath: v1 }),
      client.request<GraphData>({ kind: 'graph', vaultPath: v2 }),
    ]);
    assert.deepEqual(g1.nodes.map((n) => n.key), ['one.md']);
    assert.deepEqual(g2.nodes.map((n) => n.key), ['two.md']);
  });
});
