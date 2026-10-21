import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  computeExportRect,
  exportFileName,
  resolveExportScale,
  viewportWorldRect,
} from './exportImage.ts';

/**
 * Unit tests for the graph image-export helpers.
 *
 * 这些是「一键出图」的几何与规格计算：取景矩形、导出倍率、文件名。
 * 卡片版式（标题/图例/署名）的测试在同目录的 exportCard.test.ts。
 * 引擎的 captureImage() 只做 Pixi 调用，所有可算的东西都在这里，便于回归。
 *
 * 坐标系（关键）：Pixi 的 `extract.canvas({ frame })` 走
 * `generateTexture` → `renderer.render({ container, transform: translate(-frame.x,-frame.y) })`，
 * 即 **frame 用 world(stage-local) 空间，且 stage 自身的缩放/位移被覆盖**。
 * 所以这里的矩形全部按 world 空间算，屏幕空间只用于「倍率」。
 */

const VIEWPORT = { x: 0, y: 0, w: 1000, h: 1000 };

// ── viewportWorldRect ──

describe('viewportWorldRect', () => {
  it('maps the canvas back through the view transform', () => {
    const r = viewportWorldRect({ tx: -100, ty: -50, k: 2 }, { w: 800, h: 600 });
    assert.deepStrictEqual(r, { x: 50, y: 25, w: 400, h: 300 });
  });

  it('is a no-op at identity', () => {
    assert.deepStrictEqual(viewportWorldRect({ tx: 0, ty: 0, k: 1 }, { w: 500, h: 400 }), {
      x: 0,
      y: 0,
      w: 500,
      h: 400,
    });
  });
});

// ── computeExportRect ──

describe('computeExportRect', () => {
  it('pads the content box on all sides', () => {
    const r = computeExportRect({ x: 200, y: 300, w: 400, h: 200 }, VIEWPORT, 10);
    assert.deepStrictEqual(r, { x: 190, y: 290, w: 420, h: 220 });
  });

  it('clips the padding to the viewport instead of growing past it', () => {
    const r = computeExportRect({ x: 0, y: 0, w: 400, h: 200 }, VIEWPORT, 10);
    assert.deepStrictEqual(r, { x: 0, y: 0, w: 410, h: 210 });
  });

  it('clips content that sticks out of the viewport', () => {
    const r = computeExportRect({ x: -100, y: -100, w: 400, h: 400 }, VIEWPORT, 0);
    assert.deepStrictEqual(r, { x: 0, y: 0, w: 300, h: 300 });
  });

  it('returns null when the content does not overlap the viewport', () => {
    assert.strictEqual(computeExportRect({ x: 2000, y: 0, w: 100, h: 100 }, VIEWPORT, 10), null);
  });

  it('returns null for degenerate content', () => {
    assert.strictEqual(computeExportRect({ x: 0, y: 0, w: 0, h: 0 }, VIEWPORT, 10), null);
  });
});

// ── resolveExportScale ──

describe('resolveExportScale', () => {
  it('sizes the frame so its long edge lands on the target', () => {
    assert.strictEqual(resolveExportScale(1000, { target: 2000 }), 2);
    assert.strictEqual(resolveExportScale(250, { target: 2000 }), 8);
  });

  it('never downsamples below 1:1 world units', () => {
    // 大图：0.5 会丢信息，抬到 1（输出 4000，超目标但仍在 4096 上限内）
    assert.strictEqual(resolveExportScale(4000, { target: 2000 }), 1);
  });

  it('caps the output long edge when 1:1 would blow past it', () => {
    const scale = resolveExportScale(6000, { target: 2000, maxOutputLongEdge: 4096 });
    assert.ok(Math.abs(scale - 4096 / 6000) < 1e-9, `got ${scale}`);
  });

  it('returns 1 for a non-positive long edge', () => {
    assert.strictEqual(resolveExportScale(0, { target: 2000 }), 1);
  });
});

// ── exportFileName ──

describe('exportFileName', () => {
  it('stamps the local date and time, zero-padded', () => {
    // 月份 0 基：9 = 十月
    assert.strictEqual(exportFileName(new Date(2026, 9, 7, 9, 5)), 'molio-graph-20261007-0905.png');
  });

  it('contains nothing a filesystem would reject', () => {
    const name = exportFileName(new Date(2026, 11, 31, 23, 59));
    assert.match(name, /^[A-Za-z0-9._-]+$/);
    assert.ok(name.endsWith('.png'));
  });

  it('puts the vault name in the filename so downloads are identifiable', () => {
    assert.strictEqual(
      exportFileName(new Date(2026, 9, 17, 15, 30), '法考 刑法'),
      'molio-graph-法考-刑法-20261017-1530.png',
    );
  });

  it('strips characters Windows rejects instead of shipping a broken name', () => {
    const name = exportFileName(new Date(2026, 9, 17, 15, 30), 'a/b:c*?"<>|d');
    assert.strictEqual(name, 'molio-graph-a-b-c-d-20261017-1530.png');
  });

  it('falls back to the generic name for a blank title', () => {
    assert.strictEqual(exportFileName(new Date(2026, 9, 17, 15, 30), '   '), 'molio-graph-20261017-1530.png');
  });

  it('caps an overlong title so the path stays manageable', () => {
    const name = exportFileName(new Date(2026, 9, 17, 15, 30), '#'.repeat(100));
    assert.ok(name.startsWith('molio-graph-'), name);
    assert.ok(name.length < 80, `length=${name.length}`);
  });
});
