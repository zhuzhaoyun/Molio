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

export interface VaultJobMessage {
  kind: 'graph' | 'tree' | '__test-crash' | '__test-hang';
  vaultPath?: string;
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
      post({ id, ok: true, result: buildGraph(vaultPath) });
      return;
    }
    if (job.kind === 'tree') {
      post({ id, ok: true, result: await buildAnnotatedTree(vaultPath) });
      return;
    }

    throw new Error(`unknown vault job kind: ${String(job.kind)}`);
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
