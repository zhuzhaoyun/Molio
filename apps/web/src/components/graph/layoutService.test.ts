import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutService, type LayoutWorkerLike } from './layoutService.ts';

/**
 * LayoutService 行为约定测试（设计 docs/2026-11-18-graph-h2-expand-interaction-design.md
 * §4.2 + 代拍 P：模块单例、键=vault+scope 后启停前启、代次防串、dispose）。
 * 用假 worker 工厂直测（node:test 无真 Worker；协议与 layoutWorker.ts 对齐）。
 */

class FakeWorker implements LayoutWorkerLike {
  posted: Array<{ type: string; gen: number; [k: string]: unknown }> = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;

  postMessage(msg: unknown): void {
    this.posted.push(msg as { type: string; gen: number });
  }
  terminate(): void {
    this.terminated = true;
  }
  /** 测试驱动：模拟布局完成回包 */
  replyDone(gen: number, positions: Array<[string, number, number]>): void {
    this.onmessage?.({ data: { type: 'done', gen, positions } });
  }
}

function makeService(): { svc: ReturnType<typeof createLayoutService>; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const svc = createLayoutService(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { svc, workers };
}

describe('ensure 生命周期（代拍 P）', () => {
  it('同 key 幂等：二次 ensure 不再 post', () => {
    const { svc, workers } = makeService();
    svc.ensure('v1|global', ['a', 'b'], [{ source: 'a', target: 'b' }]);
    svc.ensure('v1|global', ['a', 'b'], [{ source: 'a', target: 'b' }]);
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.posted.length, 1);
  });

  it('换 key：先 terminate 旧 worker 再启新轮（gen 递增），就绪态复位', () => {
    const { svc, workers } = makeService();
    svc.ensure('v1|global', ['a'], []);
    workers[0]!.replyDone(1, [['a', 1, 1]]);
    assert.ok(svc.isReady());
    svc.ensure('v2|global', ['c'], []);
    assert.ok(workers[0]!.terminated);
    assert.equal(workers.length, 2);
    assert.equal(workers[1]!.posted[0]!.gen, 2);
    assert.ok(!svc.isReady());
    assert.equal(svc.getPositions(), null);
  });

  it('就绪前重复 ensure 同 key 仍幂等（运行中不重启）', () => {
    const { svc, workers } = makeService();
    svc.ensure('v1|global', ['a'], []);
    svc.ensure('v1|global', ['a', 'b'], [{ source: 'a', target: 'b' }]);
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.posted.length, 1);
  });
});

describe('done 回包', () => {
  it('就绪：positions 建成 Map + onReady 触发且可退订', () => {
    const { svc, workers } = makeService();
    let fired = 0;
    const unsub = svc.onReady(() => fired++);
    svc.ensure('v1|global', ['a', 'b'], []);
    workers[0]!.replyDone(1, [
      ['a', 1.5, 2.5],
      ['b', 3, 4],
    ]);
    assert.ok(svc.isReady());
    assert.deepEqual(svc.getPositions()?.get('a'), { x: 1.5, y: 2.5 });
    assert.deepEqual(svc.getPositions()?.get('b'), { x: 3, y: 4 });
    assert.equal(fired, 1);
    unsub();
    workers[0]!.replyDone(1, [['a', 9, 9]]); // 同 gen 重复回包：不再触发（轮次已完结）
    assert.equal(fired, 1);
  });

  it('旧 gen 迟到回包被丢（isReady 不被污染）', () => {
    const { svc, workers } = makeService();
    svc.ensure('v1|global', ['a'], []);
    svc.ensure('v2|global', ['c'], []);
    workers[0]!.replyDone(1, [['a', 9, 9]]); // 旧 worker 的迟到回包
    assert.ok(!svc.isReady());
    assert.equal(svc.getPositions(), null);
    workers[1]!.replyDone(2, [['c', 1, 1]]);
    assert.deepEqual(svc.getPositions()?.get('c'), { x: 1, y: 1 });
  });
});

describe('dispose', () => {
  it('terminate 当前 worker，状态复位', () => {
    const { svc, workers } = makeService();
    svc.ensure('v1|global', ['a'], []);
    svc.dispose();
    assert.ok(workers[0]!.terminated);
    assert.ok(!svc.isReady());
  });
});
