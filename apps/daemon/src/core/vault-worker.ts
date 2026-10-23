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
import { existsSync } from 'node:fs';
import type { GraphData, TreeNode } from '@molio/contracts';
import type { VaultJobMessage } from './vault-worker-entry.js';

export type VaultJob =
  | { kind: 'graph'; vaultPath: string; __testBlockMs?: number }
  | { kind: 'tree'; vaultPath: string; __testBlockMs?: number }
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

// 一个进程各一条线程，懒启动。构造本身没有副作用（不会起线程）。
const graphClient = new VaultWorkerClient();
const treeClient = new VaultWorkerClient();

/** 全量图谱构建（整库扫描）——路由与 worker 的接缝。 */
export function buildGraphInWorker(vaultPath: string): Promise<GraphData> {
  return graphClient.request<GraphData>({ kind: 'graph', vaultPath });
}

/** 文件树构建（scanTree + wiki 状态标注）——路由与 worker 的接缝。 */
export function buildTreeInWorker(vaultPath: string): Promise<TreeNode[]> {
  return treeClient.request<TreeNode[]>({ kind: 'tree', vaultPath });
}

/** 关停用：结束两条扫描线程（优雅退出时调用；进程退出也会带走它们）。 */
export function disposeVaultWorkers(): void {
  graphClient.dispose();
  treeClient.dispose();
}
