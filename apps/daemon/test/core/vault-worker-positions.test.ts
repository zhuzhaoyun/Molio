import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  buildGraphInWorker,
  getGraphPositions,
  crashGraphWorkerForTest,
  blockGraphWorkerForTest,
} from '../../src/core/vault-worker.js';
import type { GraphData, GraphPositions } from '@molio/contracts';

/**
 * H3 Task 3 集成：PositionStore + 后台分片预跑（走真实 worker 线程）。
 *
 * 三件必须钉死的行为：
 * 1. 图构建完成后，后台预跑最终把 positions 铺满全部节点键（投递数据源）；
 * 2. **可抢占**：预跑占着图线程跑的时候，另一个 vault 的图任务必须很快被服务
 *    （分片让路）——图/树各一条线程，能被预跑拖住的只有图任务，测试也用图任务；
 * 3. **崩溃自愈**：图线程崩掉后 PositionStore 随线程消失，重建 + 重新建图后
 *    positions 能重新铺满（进程不死、无坏状态）。
 */

const dirs: string[] = [];

/** 环形互链 fixture：dirCount 个目录 × perDir 篇，目录内环形互链 + 少量跨目录 */
function makeVault(dirCount: number, perDir: number): string {
  const root = mkdtempSync(join(tmpdir(), 'molio-h3-prerun-'));
  dirs.push(root);
  const name = (d: number, i: number) => `d${d}n${String(i).padStart(3, '0')}`;
  for (let d = 0; d < dirCount; d++) mkdirSync(join(root, `dir${d}`), { recursive: true });
  for (let d = 0; d < dirCount; d++) {
    for (let i = 0; i < perDir; i++) {
      const self = name(d, i);
      const next = name(d, (i + 1) % perDir); // 环形
      const cross = name((d + 1) % dirCount, i); // 跨目录
      writeFileSync(
        join(root, `dir${d}`, `${self}.md`),
        `# ${self}\n\n- [[${next}]]\n- [[${cross}]]\n`,
      );
    }
  }
  return root;
}

async function pollPositions(vaultPath: string, timeoutMs: number): Promise<GraphPositions | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await getGraphPositions(vaultPath);
    if (p) return p;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('PositionStore + 后台分片预跑（真实 worker 线程）', () => {
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('图构建后 positions 最终铺满全部节点键', async () => {
    const vault = makeVault(4, 20); // 80 节点
    const g: GraphData = await buildGraphInWorker(vault);
    assert.ok(g.nodes.length >= 80, `节点数异常: ${g.nodes.length}`);
    const positions = await pollPositions(vault, 10_000);
    assert.ok(positions, '10s 内 positions 未就绪');
    assert.equal(positions.length, g.nodes.length);
    const keySet = new Set(g.nodes.map((n) => n.key));
    for (const [k, x, y] of positions) {
      assert.ok(keySet.has(k), `positions 含未知键 ${k}`);
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
  });

  it('预跑占线程时，另一 vault 的图任务被快速服务（分片让路）', async () => {
    const big = makeVault(20, 20); // 400 节点——预跑有足够长度可被打断
    const small = makeVault(1, 3); // 3 节点
    const gBig = await buildGraphInWorker(big);
    assert.ok(gBig.nodes.length >= 400);
    // 不等预跑：立刻发小图任务（同一条图线程），带 50ms 模拟负载
    const t0 = Date.now();
    const gSmall = await buildGraphInWorker(small);
    const latency = Date.now() - t0;
    assert.ok(gSmall.nodes.length >= 3);
    assert.ok(latency < 1500, `图任务被预跑拖住 ${latency}ms（分片让路失效）`);
    // 小任务完成时，大库预跑应仍在途（证明真的抢占了，而不是预跑恰好已结束）
    const early = await getGraphPositions(big);
    assert.equal(early, null, '预跑在小图任务完成前不应已就绪');
    const positions = await pollPositions(big, 10_000);
    assert.ok(positions, '抢占后预跑恢复并完成');
    assert.equal(positions.length, gBig.nodes.length);
  });

  it('图线程崩溃自愈：Store 随线程消失，重建后 positions 重新铺满', async () => {
    const vault = makeVault(3, 10);
    await buildGraphInWorker(vault);
    const first = await pollPositions(vault, 10_000);
    assert.ok(first);
    // 崩掉共享图线程（在途 reject + 下次请求重建）
    await assert.rejects(crashGraphWorkerForTest(), /crashed|exited/);
    // 线程重建后 Store 是空的（无坏状态泄漏）
    assert.equal(await getGraphPositions(vault), null);
    const g = await buildGraphInWorker(vault);
    const again = await pollPositions(vault, 10_000);
    assert.ok(again, '重建 + 重新建图后 positions 重新就绪');
    assert.equal(again.length, g.nodes.length);
  });

  it('positions 软探测：worker 被占住时快速回 null，且不弄死 worker（终审 Important-1）', async () => {
    const vault = makeVault(2, 8);
    await buildGraphInWorker(vault);
    const positions = await pollPositions(vault, 10_000);
    assert.ok(positions);
    // 占住图线程 2.5s（busy-wait 模拟长构建/慢盘）——期间探测 positions：
    // 旧实现会跟着等满 2.5s；软探测必须独立短超时（1.5s 内）回 null，且
    // 之后 worker 仍活着（被占任务收场、后续建图正常）——绝不能因为探测
    // 超时去 terminate 线程（那会把缓存命中的 GET 拴在 worker 健康度上，
    // 连累别的库在途构建）。
    const blocked = blockGraphWorkerForTest(2500).catch(() => {}); // 占位路径不存在 → 结束时 reject，无害
    await new Promise((r) => setTimeout(r, 50)); // 确保 busy-wait 已开场
    const t0 = Date.now();
    const probed = await getGraphPositions(vault);
    const probeMs = Date.now() - t0;
    assert.equal(probed, null, '占用期间软探测应回 null（不硬等）');
    assert.ok(probeMs < 2000, `探测耗时 ${probeMs}ms 应 < 2s`);
    await blocked;
    // worker 存活：真实建图照常成功
    const g = await buildGraphInWorker(vault);
    assert.ok(g.nodes.length > 0);
  });
});
