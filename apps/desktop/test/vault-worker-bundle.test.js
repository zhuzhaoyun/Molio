/**
 * 桌面端打包必须**单独**产出一份 vault 扫描 worker（resources/daemon/vault-worker-entry.mjs）。
 *
 * 背景：daemon 被打成单文件 resources/daemon/daemon.mjs（esbuild）。图谱/文件树的
 * 整库扫描跑在 worker 线程里（core/vault-worker.ts），入口通过
 * `new Worker(new URL('./vault-worker-entry.mjs', import.meta.url))` 定位——
 * 单文件 bundle 里没有这个文件，所以 prepare-resources 必须把它单独打出来。
 * 漏了不会在构建期报错：开发模式（dist/.js）完全正常，只有装出来的应用里
 * 打开图谱时才 500。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prepareResourcesPath = path.resolve(__dirname, '../scripts/prepare-resources.mjs');
const prepareResourcesJs = readFileSync(prepareResourcesPath, 'utf-8');
const workerBundle = path.resolve(__dirname, '../resources/daemon/vault-worker-entry.mjs');

describe('prepare-resources.mjs: vault worker bundle', () => {
  it('存在 bundleVaultWorker()，且被 prepare 流程调用', () => {
    assert.ok(
      prepareResourcesJs.includes('async function bundleVaultWorker()'),
      'prepare-resources.mjs 必须有 bundleVaultWorker()',
    );
    assert.match(
      prepareResourcesJs,
      /await bundleVaultWorker\(\);/,
      'bundleVaultWorker() 必须被调用（否则包里没有 worker 入口）',
    );
  });

  it('worker 入口取自编译产物、输出为 resources/daemon/vault-worker-entry.mjs', () => {
    const fnIdx = prepareResourcesJs.indexOf('async function bundleVaultWorker()');
    const slice = prepareResourcesJs.slice(fnIdx, fnIdx + 2000);
    assert.ok(
      slice.includes("'core', 'vault-worker-entry.js'") || slice.includes("core/vault-worker-entry.js"),
      'entryPoint 必须是 daemon dist 里的 core/vault-worker-entry.js',
    );
    assert.ok(
      slice.includes("'vault-worker-entry.mjs'"),
      'outfile 必须是 vault-worker-entry.mjs（ESM，且与 core/vault-worker.ts 的探测顺序一致）',
    );
    assert.ok(
      slice.includes("format: 'esm'"),
      'worker bundle 必须是 ESM（与 daemon.mjs 同因：ELECTRON_RUN_AS_NODE 下 .mjs 才按 ESM 解析）',
    );
  });

  it('daemon 侧的探测顺序把 .mjs 放在第一位（打包形态）', () => {
    // core/vault-worker.ts 的 ENTRY_CANDIDATES 顺序决定了打包后能不能找到入口。
    const src = readFileSync(
      path.resolve(__dirname, '../../daemon/src/core/vault-worker.ts'),
      'utf-8',
    );
    const m = src.match(/const ENTRY_CANDIDATES = \[([^\]]+)\]/);
    assert.ok(m, 'ENTRY_CANDIDATES 必须存在');
    const candidates = m[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
    assert.deepEqual(candidates, ['vault-worker-entry.mjs', 'vault-worker-entry.js', 'vault-worker-entry.ts']);
  });
});

describe('bundled vault worker (integration)', () => {
  const hasBundle = existsSync(workerBundle);

  it('worker bundle 能启动并回答一次 graph 任务（或跳过）', { skip: !hasBundle }, async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'molio-worker-bundle-'));
    try {
      writeFileSync(path.join(vault, 'a.md'), '# A\n\n[[b]]\n', 'utf-8');
      writeFileSync(path.join(vault, 'b.md'), '# B\n', 'utf-8');

      const worker = new Worker(pathToFileURL(workerBundle));
      try {
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker did not reply in 20s')), 20_000);
          worker.once('message', (msg) => {
            clearTimeout(timer);
            resolve(msg);
          });
          worker.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
          worker.postMessage({ id: 1, job: { kind: 'graph', vaultPath: vault } });
        });

        assert.equal(reply.ok, true, `worker 回包失败：${reply.error}`);
        assert.deepEqual(reply.result.nodes.map((n) => n.key).sort(), ['a.md', 'b.md']);
      } finally {
        await worker.terminate();
      }
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
