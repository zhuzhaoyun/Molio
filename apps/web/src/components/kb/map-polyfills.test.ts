import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMapPolyfills } from './map-polyfills.ts';

// 导入 map-polyfills 即触发副作用 installMapPolyfills()（文件底部）——Node 24 恰好没有
// Math.sumPrecise / Map.prototype.getOrInsert*（等同 Electron 40 / Chromium 144 缺失场景），
// 因此这里测到的正是 polyfill 本身，而非引擎原生实现。

test('map-polyfills 补齐 Math.sumPrecise 且求和语义正确', () => {
  installMapPolyfills();
  assert.equal(typeof Math.sumPrecise, 'function');
  assert.equal(Math.sumPrecise([1, 2, 3]), 6);
  assert.equal(Math.sumPrecise([0.1, 0.2]), 0.1 + 0.2); // IEEE 754 浮点累加
  assert.equal(Math.sumPrecise([]), 0);
  // pdf.js 用它求缓冲长度：传入的都是小整数
  assert.equal(Math.sumPrecise([1024, 512, 256]), 1792);
});

test('installMapPolyfills 幂等：已存在时不覆盖', () => {
  const sp = Math.sumPrecise;
  assert.equal(typeof sp, 'function');
  installMapPolyfills();
  installMapPolyfills();
  assert.equal(typeof Math.sumPrecise, 'function');
  assert.equal(Math.sumPrecise, sp, '已存在的 sumPrecise 不应被覆盖');
});

test('installMapPolyfills 补齐 Map.prototype.getOrInsert / getOrInsertComputed', () => {
  installMapPolyfills();
  assert.equal(typeof Map.prototype.getOrInsert, 'function');
  assert.equal(typeof Map.prototype.getOrInsertComputed, 'function');
  const m = new Map<string, number>();
  m.getOrInsert('k', 1);
  assert.equal(m.getOrInsert('k', 2), 1, 'getOrInsert 应保留现值');
  assert.equal(m.getOrInsertComputed('c', (k) => k.length), 1);
  assert.equal(m.getOrInsertComputed('c', () => 99), 1, 'getOrInsertComputed 应命中缓存');
});
