import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNearBottom, PIN_THRESHOLD_PX } from './chatScrollPin.ts';

test('isNearBottom: exactly at bottom → true', () => {
  assert.equal(isNearBottom(1000, 1500, 500), true);
});

test('isNearBottom: within threshold → true', () => {
  // 距底 50px（< 默认 80px 阈值）
  assert.equal(isNearBottom(950, 1500, 500), true);
});

test('isNearBottom: just beyond threshold → false', () => {
  // 距底 81px（> 默认 80px 阈值）——用户已上翻，脱离跟随
  assert.equal(isNearBottom(919, 1500, 500), false);
});

test('isNearBottom: scrolled to top of long content → false', () => {
  assert.equal(isNearBottom(0, 5000, 500), false);
});

test('isNearBottom: content shorter than viewport (no overflow) → true', () => {
  // scrollHeight < clientHeight：距离为负，视为贴底
  assert.equal(isNearBottom(0, 300, 500), true);
});

test('isNearBottom: custom threshold overrides default', () => {
  assert.equal(isNearBottom(880, 1500, 500, 200), true);
  assert.equal(isNearBottom(880, 1500, 500, 100), false);
});

test('PIN_THRESHOLD_PX is 80', () => {
  assert.equal(PIN_THRESHOLD_PX, 80);
});
