import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TreeCache } from '../../src/core/tree-cache.js';
import type { TreeNode } from '@molio/contracts';

/**
 * TreeCache 单元测试——与 graph-cache.test.ts 同一套判据，外加 single-flight
 * （树的构建是 async 且耗时几秒，并发的多个请求必须共享同一次构建）。
 */

const node = (name: string): TreeNode[] => [{ name, path: name, type: 'file' }];

describe('TreeCache', () => {
  it('同一 vault 多次取用只构建一次', async () => {
    const cache = new TreeCache();
    let builds = 0;
    const a = await cache.getOrBuild('v1', async () => {
      builds++;
      return node('a.md');
    });
    const b = await cache.getOrBuild('v1', async () => {
      builds++;
      return node('b.md');
    });
    assert.equal(builds, 1);
    assert.equal(a, b, '命中必须返回同一个对象（树不应被重复扫描）');
  });

  it('冷缓存上的并发请求共享同一次构建（single-flight）', async () => {
    const cache = new TreeCache();
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const build = async (): Promise<TreeNode[]> => {
      builds++;
      await gate;
      return node('slow.md');
    };

    const p1 = cache.getOrBuild('v1', build);
    const p2 = cache.getOrBuild('v1', build);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(builds, 1, '并发窗口内只允许一次构建');
    assert.equal(r1, r2);
  });

  it('构建期间发生的失效不被吞掉：构建完成的旧快照不入缓存（大库 async 扫描窗口）', async () => {
    let clock = 1_000;
    const cache = new TreeCache(4, 2 * 60 * 1000, () => clock);
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const build = async (): Promise<TreeNode[]> => {
      builds++;
      await gate;
      return node(`snapshot-${builds}.md`);
    };

    const building = cache.getOrBuild('v1', build); // t=1000 开始构建（要几秒）
    clock = 2_000;
    cache.invalidate('v1'); // 构建中途，外部落盘 → tree-changed
    release();
    const tree = await building; // 本次调用照常拿到点内快照
    assert.equal(tree[0]!.name, 'snapshot-1.md');

    clock = 2_500;
    await cache.getOrBuild('v1', build); // 下一次请求必须重新构建，而不是吃旧快照
    assert.equal(builds, 2, '被失效打断过的构建结果不许留在缓存里');
  });

  it('invalidate 后同一 vault 重新构建（tree-changed / API 写的失效路径）', async () => {
    const cache = new TreeCache();
    let builds = 0;
    await cache.getOrBuild('v1', async () => {
      builds++;
      return node('old.md');
    });
    cache.invalidate('v1');
    await cache.getOrBuild('v1', async () => {
      builds++;
      return node('new.md');
    });
    assert.equal(builds, 2);
    const tree = await cache.getOrBuild('v1', async () => {
      builds++;
      return node('x.md');
    });
    assert.equal(builds, 2);
    assert.equal(tree[0]!.name, 'new.md');
  });

  it('TTL 过期后重建（watcher 信号哑掉时的兜底，不让缓存无限期陈旧）', async () => {
    let clock = 1_000;
    const cache = new TreeCache(4, 2 * 60 * 1000, () => clock);
    let builds = 0;
    const build = async (): Promise<TreeNode[]> => {
      builds++;
      return node(`n${builds}.md`);
    };
    await cache.getOrBuild('v1', build);
    clock += 2 * 60 * 1000 - 1;
    await cache.getOrBuild('v1', build);
    assert.equal(builds, 1, 'TTL 边界内仍命中');
    clock += 1;
    await cache.getOrBuild('v1', build);
    assert.equal(builds, 2, 'TTL 过期必须重建');
  });

  it('超过容量上限时按 LRU 淘汰最久未用的 vault', async () => {
    const cache = new TreeCache(2);
    const names = ['v1', 'v2', 'v3'];
    const builds: Record<string, number> = {};
    const buildOf = (v: string) => async (): Promise<TreeNode[]> => {
      builds[v] = (builds[v] ?? 0) + 1;
      return node(`${v}.md`);
    };
    await cache.getOrBuild('v1', buildOf('v1'));
    await cache.getOrBuild('v2', buildOf('v2'));
    await cache.getOrBuild('v1', buildOf('v1')); // v1 变成最近使用
    await cache.getOrBuild('v3', buildOf('v3')); // 淘汰 v2
    await cache.getOrBuild('v1', buildOf('v1'));
    await cache.getOrBuild('v2', buildOf('v2')); // v2 重新构建（曾被淘汰）
    assert.equal(builds['v1'], 1, 'v1 一直在缓存里');
    assert.equal(builds['v2'], 2, 'v2 被淘汰后重建');
  });

  it('构建抛错：并发等待者都收到 rejection，下次调用重新构建', async () => {
    const cache = new TreeCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const failing = async (): Promise<TreeNode[]> => {
      calls++;
      await gate;
      throw new Error('disk yanked');
    };

    const p1 = cache.getOrBuild('v1', failing);
    const p2 = cache.getOrBuild('v1', failing);
    release();
    await assert.rejects(p1, /disk yanked/);
    await assert.rejects(p2, /disk yanked/);

    // 恢复后重新构建成功（能拿到新结果本身就证明 in-flight 已清、失败未被记住）
    const tree = await cache.getOrBuild('v1', async () => node('ok.md'));
    assert.equal(tree[0]!.name, 'ok.md');
    assert.equal(calls, 1, '并发等待者共享同一次构建（single-flight 的意义所在）');
  });
});
