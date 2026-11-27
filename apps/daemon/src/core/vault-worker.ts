/**
 * vault 扫描任务的 worker 线程客户端。
 *
 * 为什么需要：`buildGraph`（整库扫目录 + 逐 md 读内容解析 wikilink）与
 * `scanTree`（整棵目录树 + 逐文件 stat）都是**同步**的整库操作。实测用户从移动
 * 硬盘挂载的库（70k 文件 / 6.5k md）建图 5.2s、扫树 2.95s——这段时间跑在请求
 * 线程上，daemon 干不了别的：文件树、聊天 SSE、剪藏全部一起卡。缓存（GraphCache
 * / TreeCache）只消除「重复扫描」，消不掉「扫描期间应用无响应」；这一层把扫描
 * 挪出事件循环。
 *
 * **两条独立的线程**（图一条、树一条）：打开知识库时界面会同时拉树和图，串在
 * 一条线程上就会互相排队（3s + 5s）；分开后各跑各的。树的 worker 还顺带保住了
 * `annotateTreeStatus` 的 wiki 解析缓存——它挂在模块内存里，每次新建线程就白费。
 *
 * **生命周期**：
 * - 懒启动（第一次请求才建线程），空闲时 `unref()`（不拖住进程退出），有在途
 *   任务时 `ref()`（结果没回来之前父进程不会自己走掉，测试同理）；
 * - 构建抛错 → 通过 ok:false 回传，线程继续可用；
 * - 线程崩溃/被 terminate/任务超时 → 在途任务全部 reject，下一次请求重建线程。
 *   失败不入缓存是调用方（VaultCache）的事，这里只保证「不留下坏状态」。
 *
 * **路径解析**：入口文件可能是编译产物（dist/…/vault-worker-entry.js）、源码
 * 直跑（tsx 下只有 .ts，execArgv 里的 tsx loader 会被 worker 继承）、或桌面端
 * esbuild 单文件旁（vault-worker-entry.mjs）。三种都探一遍。
 */

import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { GraphData, GraphPositions, TreeNode } from '@molio/contracts';
import type { ExternalRootRef } from './external-roots.js';
import type { VaultJobMessage } from './vault-worker-entry.js';
import { DEFAULT_TRUNK_MIN_NODES, CLUSTER_RECURSE_CAP } from './graph-communities.js';

export type VaultJob =
  | {
      kind: 'graph';
      vaultPath: string;
      externalRoots?: ExternalRootRef[];
      /** trunk 视图小库门（T1）：client 侧从 MOLIO_GRAPH_TRUNK_MIN_NODES 现读随消息传入 */
      trunkMinNodes?: number;
      /** 递归分级门（换核 §四）：client 侧从 MOLIO_GRAPH_RECURSE_CAP 现读随消息传入 */
      recurseCap?: number;
      __testBlockMs?: number;
    }
  | { kind: 'tree'; vaultPath: string; externalRoots?: ExternalRootRef[]; __testBlockMs?: number }
  | { kind: 'positions'; vaultPath: string }
  | { kind: '__test-crash' }
  | { kind: '__test-hang' };

interface PendingJob {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 单个任务的超时上限。正常整库扫描是秒级；超过这个量级基本是盘挂起（移动硬盘
 * 休眠/掉线）或死循环——继续等下去只会把所有在途请求一起拖死，不如收场重来。
 */
const DEFAULT_JOB_TIMEOUT_MS = 3 * 60 * 1000;

const ENTRY_CANDIDATES = ['vault-worker-entry.mjs', 'vault-worker-entry.js', 'vault-worker-entry.ts'] as const;

/**
 * 线程入口路径：与本源文件同目录，按打包形态挑扩展名
 * （桌面端 .mjs / dist .js / tsx 直跑 .ts）。
 */
export function resolveWorkerEntryUrl(): URL {
  const dir = new URL('./', import.meta.url);
  for (const name of ENTRY_CANDIDATES) {
    const candidate = new URL(name, dir);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `vault worker entry not found next to ${dir.href} (looked for ${ENTRY_CANDIDATES.join(', ')})`,
  );
}

export class VaultWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingJob>();
  private nextId = 1;

  constructor(private readonly timeoutMs: number = DEFAULT_JOB_TIMEOUT_MS) {}

  /** 发一个任务，等结果。失败（构建抛错/线程崩溃/超时）一律 reject。 */
  request<T>(job: VaultJob): Promise<T> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.onTimeout(id, job.kind), this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      worker.ref();
      try {
        worker.postMessage({ id, job: job satisfies VaultJobMessage });
      } catch (err) {
        this.settle(id, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * 软探测（终审 Important-1）：独立短超时的 best-effort 请求。超时只作废本次
   * 等待并 resolve null——**绝不 terminate/reset 线程**（种子是附加数据，不能把
   * 缓存命中的 GET 拴在 worker 健康度上：worker 被长构建占住/慢盘挂起时，硬等
   * 会拖满 3 分钟任务超时并触发 reset，连累别的库在途构建）。迟到回包由
   * settle 的 pending 缺失检查静默丢弃；崩溃 reset 的 reject 也转 null。
   */
  softRequest<T>(job: VaultJob, timeoutMs: number): Promise<T | null> {
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker?.unref();
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(null);
        },
        timer,
      });
      worker.ref();
      try {
        worker.postMessage({ id, job: job satisfies VaultJob });
      } catch {
        this.settle(id, errLike('post failed'));
      }
    });
  }

  /** 关停用：terminate 线程，在途任务全部 reject。之后再请求会重新建线程。 */
  dispose(): void {
    this.reset(new Error('vault worker disposed'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(resolveWorkerEntryUrl());
    // 空闲时别拖住进程退出；request() 里会 ref 住有在途任务的那段时间。
    worker.unref();
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      if (msg.ok) this.settle(msg.id, null, msg.result);
      else this.settle(msg.id, new Error(msg.error ?? 'vault worker job failed'));
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      console.warn(`[vault-worker] thread crashed: ${err.message}`);
      this.reset(new Error(`vault worker crashed: ${err.message}`));
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      console.warn(`[vault-worker] thread exited unexpectedly (code ${code})`);
      this.reset(new Error(`vault worker exited (code ${code})`));
    });

    this.worker = worker;
    return worker;
  }

  private onTimeout(id: number, kind: VaultJob['kind']): void {
    if (!this.pending.has(id)) return;
    const err = new Error(`vault worker job timed out after ${this.timeoutMs}ms (kind=${kind})`);
    this.settle(id, err);
    // 超时说明线程已经卡住（盘挂起/死循环），留着只会拖死后续请求。
    this.reset(err);
  }

  /** 收场当前线程：终止它，把所有在途任务以同一个原因 reject，下次请求重建。 */
  private reset(reason: Error): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      // 先摘监听，避免 terminate 触发的 'exit' 再走一遍 reset。
      worker.removeAllListeners();
      void worker.terminate();
    }
    for (const id of [...this.pending.keys()]) this.settle(id, reason);
  }

  private settle(id: number, err: Error | null, value?: unknown): void {
    const job = this.pending.get(id);
    if (!job) return;
    this.pending.delete(id);
    clearTimeout(job.timer);
    if (this.pending.size === 0) this.worker?.unref();
    if (err) job.reject(err);
    else job.resolve(value);
  }
}

function errLike(msg: string): Error {
  return new Error(msg);
}

// 一个进程各一条线程，懒启动。构造本身没有副作用（不会起线程）。
const graphClient = new VaultWorkerClient();
const treeClient = new VaultWorkerClient();

/**
 * trunk 视图小库门阈值（T1）：MOLIO_GRAPH_TRUNK_MIN_NODES，未设/非法 →
 * DEFAULT_TRUNK_MIN_NODES；解析为数字，≤0 视为 0（强制启用，E2E 造 trunk fixture 用）。
 * 每次调用现读：测试可在请求间隙改 env。
 */
export function readTrunkMinNodesEnv(): number {
  const raw = process.env.MOLIO_GRAPH_TRUNK_MIN_NODES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUNK_MIN_NODES;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TRUNK_MIN_NODES;
  return n <= 0 ? 0 : n;
}

/**
 * 递归分级门（换核设计 §四）：MOLIO_GRAPH_RECURSE_CAP，未设/非法 →
 * CLUSTER_RECURSE_CAP(300)；≤0 视为 0 = 所有簇都递归（E2E 造 fixture 用，
 * 与 readTrunkMinNodesEnv 的「≤0=强制启用」同款语义）。每次调用现读。
 */
export function readClusterRecurseCapEnv(): number {
  const raw = process.env.MOLIO_GRAPH_RECURSE_CAP;
  if (raw === undefined || raw.trim() === '') return CLUSTER_RECURSE_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CLUSTER_RECURSE_CAP;
  return n <= 0 ? 0 : n;
}

/** 全量图谱构建（整库扫描）——路由与 worker 的接缝。 */
export function buildGraphInWorker(
  vaultPath: string,
  externalRoots: ExternalRootRef[] = [],
): Promise<GraphData> {
  return graphClient.request<GraphData>({
    kind: 'graph',
    vaultPath,
    externalRoots,
    trunkMinNodes: readTrunkMinNodesEnv(),
    recurseCap: readClusterRecurseCapEnv(),
  });
}

/** 文件树构建（scanTree + wiki 状态标注）——路由与 worker 的接缝。 */
export function buildTreeInWorker(
  vaultPath: string,
  externalRoots: ExternalRootRef[] = [],
): Promise<TreeNode[]> {
  return treeClient.request<TreeNode[]>({ kind: 'tree', vaultPath, externalRoots });
}

/** positions 软探测超时：正常 worker 空闲/分片让路时毫秒级应答；被长构建占住时
 *  放弃种子（回 null）也不硬等——GET 必须快（终审 Important-1）。 */
const POSITIONS_PROBE_TIMEOUT_MS = 1500;

/** H3：读某 vault 的布局种子（worker PositionStore）。无库存（预跑未完成/线程刚重建/
 *  worker 忙到软超时）→ null。覆盖率由路由侧按当前图节点数计算——worker 只知预跑时
 *  的口径，路由才有当前图。 */
export function getGraphPositions(vaultPath: string): Promise<GraphPositions | null> {
  return graphClient.softRequest<GraphPositions | null>({ kind: 'positions', vaultPath }, POSITIONS_PROBE_TIMEOUT_MS);
}

/** 测试钩子：占住共享图线程 busy-wait 指定毫秒（路径不存在，收场时 reject 无害）——
 *  验证 positions 软探测在 worker 被占时快速回 null 且不 terminate 线程。 */
export function blockGraphWorkerForTest(blockMs: number): Promise<never> {
  return graphClient.request<never>({
    kind: 'graph',
    vaultPath: join(tmpdir(), `molio-block-${Date.now()}-${Math.random()}`),
    __testBlockMs: blockMs,
  });
}

/** 测试钩子：往共享图线程发一个会崩的任务（崩溃自愈路径端到端验证用）。 */
export function crashGraphWorkerForTest(): Promise<never> {
  return graphClient.request<never>({ kind: '__test-crash' });
}

/** 关停用：结束两条扫描线程（优雅退出时调用；进程退出也会带走它们）。 */
export function disposeVaultWorkers(): void {
  graphClient.dispose();
  treeClient.dispose();
}
