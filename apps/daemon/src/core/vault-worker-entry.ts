/**
 * vault 扫描 worker 的线程入口。
 *
 * 只做一件事：收到 { id, job } → 扫库/建图 → 回传 { id, ok, result }。
 * 不碰数据库、不碰 Hono：这里跑的都是整库级的同步 IO + CPU。
 *
 * 进程形态与路径解析见 core/vault-worker.ts。桌面端的生产包是 esbuild 单文件
 * （resources/daemon/daemon.mjs），所以 apps/desktop/scripts/prepare-resources.mjs
 * 会把本文件**单独**打成 resources/daemon/vault-worker-entry.mjs。
 */

import { parentPort } from 'node:worker_threads';
import { buildGraph } from './graph-build.js';
import { buildAnnotatedTree } from './tree-build.js';
import { detectCommunities } from './graph-communities.js';
import { createPrerun, stepPrerun, inheritOverlap, type PrerunState } from './graph-prerun.js';
import type { GraphData, GraphPositions } from '@molio/contracts';

export interface VaultJobMessage {
  kind: 'graph' | 'tree' | 'positions' | '__test-crash' | '__test-hang';
  vaultPath?: string;
  /** 外部素材根（#255）——路由侧解析自 db 随 job 传入，worker 线程不碰 db。 */
  externalRoots?: import('./external-roots.js').ExternalRootRef[];
  /** trunk 视图小库门（T1）：client 侧 readTrunkMinNodesEnv() 现读随消息传入 */
  trunkMinNodes?: number;
  /** 递归分级门（换核 §四）：client 侧 readClusterRecurseCapEnv() 现读随消息传入 */
  recurseCap?: number;
  /**
   * 测试钩子：干正事前空转这么久（毫秒），模拟一次长 CPU 构建。事件循环不被
   * 阻塞的保证靠它来断言——真实 vault 的扫描时长在 CI 上不可控。
   */
  __testBlockMs?: number;
}

export interface VaultJobReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── H3：PositionStore + 后台分片预跑（docs/2026-11-25-graph-h3-seeded-positions-design.md §3.1）──
// Store 住 worker 线程内存：跨主线程 GraphCache 的失效/TTL 存活（图缓存删了位置还在，
// 增量继承才有得继承）；只被「key 重叠 <0.5 的重建」整体重置或 LRU 挤出。
const PRERUN_CHUNK_TICKS = 40;
const POSITION_STORE_LRU = 8;
const positionStore = new Map<string, Map<string, { x: number; y: number }>>();
/** 待预跑图（vaultPath → 最新一份）。同 vault 再建图 = 覆盖旧跑（新图作废旧状态）。 */
const pendingPrerun = new Map<string, GraphData>();
let activePrerun: { vaultPath: string; state: PrerunState } | null = null;
let prerunLoopRunning = false;

function buildDegrees(g: GraphData): Map<string, number> {
  const adj = new Map<string, Set<string>>();
  for (const e of g.edges) {
    if (e.source === e.target) continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  const deg = new Map<string, number>();
  for (const n of g.nodes) deg.set(n.key, adj.get(n.key)?.size ?? 0);
  return deg;
}

function startPrerunState(vaultPath: string, g: GraphData): { vaultPath: string; state: PrerunState } {
  const keys = g.nodes.map((n) => n.key);
  const store = positionStore.get(vaultPath);
  if (store && inheritOverlap(keys, store) < 0.5) positionStore.delete(vaultPath); // 大换血 → 清空重跑
  return {
    vaultPath,
    state: createPrerun(keys, g.edges, buildDegrees(g), positionStore.get(vaultPath)),
  };
}

function storePositions(vaultPath: string, positions: GraphPositions): void {
  positionStore.delete(vaultPath); // LRU touch：删了重插到尾
  positionStore.set(vaultPath, new Map(positions.map(([k, x, y]) => [k, { x, y }])));
  while (positionStore.size > POSITION_STORE_LRU) {
    const oldest = positionStore.keys().next();
    if (oldest.done) break;
    positionStore.delete(oldest.value);
  }
}

function schedulePrerun(vaultPath: string, g: GraphData): void {
  pendingPrerun.set(vaultPath, g);
  if (prerunLoopRunning) return;
  prerunLoopRunning = true;
  void prerunLoop();
}

/** 分片跑预跑：每片同步 ≤CHUNK ticks，片间 setImmediate 让路——排队的图任务
 *  （另一 vault 的建图/positions 查询）在让路点先服务，预跑随后续跑（可抢占）。 */
async function prerunLoop(): Promise<void> {
  try {
    for (;;) {
      if (activePrerun && pendingPrerun.has(activePrerun.vaultPath)) {
        const g = pendingPrerun.get(activePrerun.vaultPath)!;
        pendingPrerun.delete(activePrerun.vaultPath);
        activePrerun = startPrerunState(activePrerun.vaultPath, g); // 新图作废旧状态
      } else if (!activePrerun) {
        const next = pendingPrerun.entries().next();
        if (next.done) break;
        const [vp, g] = next.value;
        pendingPrerun.delete(vp);
        activePrerun = startPrerunState(vp, g);
      }
      const r = stepPrerun(activePrerun.state, PRERUN_CHUNK_TICKS);
      if (r.done) {
        storePositions(activePrerun.vaultPath, r.positions);
        activePrerun = null;
      }
      await new Promise<void>((res) => setImmediate(res));
    }
  } catch (err) {
    // 预跑是 best-effort：异常只丢弃本轮，绝不影响任务通道
    console.warn('[vault-worker] prerun failed:', err instanceof Error ? err.message : err);
    activePrerun = null;
  } finally {
    prerunLoopRunning = false;
  }
}

const port = parentPort;
if (!port) {
  throw new Error('vault-worker-entry must be started as a worker thread');
}

port.on('message', (msg: { id: number; job: VaultJobMessage }) => {
  void runJob(msg);
});

function post(message: VaultJobReply): void {
  parentPort?.postMessage(message);
}

async function runJob({ id, job }: { id: number; job: VaultJobMessage }): Promise<void> {
  try {
    if (job.__testBlockMs && job.__testBlockMs > 0) {
      const end = Date.now() + job.__testBlockMs;
      while (Date.now() < end) { /* busy-wait：模拟同步扫描占满线程 */ }
    }

    if (job.kind === '__test-crash') {
      // 制造一次未捕获异常（worker 'error' 事件）——验证父进程能收场并自愈。
      setTimeout(() => {
        throw new Error('__test-crash');
      }, 0);
      return;
    }
    if (job.kind === '__test-hang') {
      // 永不回包——验证父进程的超时收场（terminate + 下次重建）。
      return;
    }

    const vaultPath = job.vaultPath;
    if (!vaultPath) throw new Error(`vault job '${job.kind}' requires vaultPath`);

    if (job.kind === 'graph') {
      // T1：communities 随图一起在 worker 线程算，一起进缓存/失效（不占请求线程）。
      // result 恒带 communities 字段（小库 = 空簇对象）；「字段缺失」语义留给旧缓存条目。
      const g = buildGraph(vaultPath, { externalRoots: job.externalRoots });
      const result = {
        ...g,
        communities: detectCommunities(g, { minNodes: job.trunkMinNodes, recurseCap: job.recurseCap }),
      };
      post({ id, ok: true, result });
      // H3：结果已回，本线程后台分片预跑布局种子（不阻塞下一任务——片间让路）
      schedulePrerun(vaultPath, g);
      return;
    }
    if (job.kind === 'positions') {
      const store = positionStore.get(vaultPath);
      if (!store) {
        post({ id, ok: true, result: null });
        return;
      }
      const positions: GraphPositions = [...store].map(([k, p]) => [k, p.x, p.y]);
      post({ id, ok: true, result: positions });
      return;
    }
    if (job.kind === 'tree') {
      post({ id, ok: true, result: await buildAnnotatedTree(vaultPath, job.externalRoots) });
      return;
    }

    throw new Error(`unknown vault job kind: ${String(job.kind)}`);
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
