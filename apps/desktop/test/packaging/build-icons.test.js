/**
 * 打包图标资产守护测试。
 *
 * 背景：#228 品牌图标重做时，icon.ico 仅包含 16x16 一层
 * （macOS `sips -s format ico` 会静默只写最小尺寸），NSIS 打包时 electron-builder
 * 校验 "icon.ico must be at least 256x256" 直接失败，阻断 v0.3.49 发版。
 *
 * 本测试解析 ico/icns 二进制头，确保桌面端图标资产始终包含打包所需尺寸：
 *   - NSIS 要求 icon.ico 至少含一层 256x256
 *   - rcedit 将 ico 各层嵌入 exe，全尺寸覆盖任务栏/资源管理器各 DPI
 *   - mac 打包读 icon.icns，需含 256/512/1024 大尺寸层
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

/** 解析 ICO 头，返回每层 {width, height}（0 字节表示 256） */
function parseIcoEntries(buf) {
  assert.equal(buf.readUInt16LE(0), 0, 'ico reserved 字段应为 0');
  assert.equal(buf.readUInt16LE(2), 1, 'ico type 字段应为 1（图标）');
  const count = buf.readUInt16LE(4);
  assert.ok(count > 0, 'ico 应至少包含一层图像');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const dim = (b) => (b === 0 ? 256 : b);
    entries.push({ width: dim(buf.readUInt8(off)), height: dim(buf.readUInt8(off + 1)) });
  }
  return entries;
}

/** 解析 ICNS 头，返回各块 OSType（ic08=256px, ic09=512px, ic10=1024px...） */
function parseIcnsTypes(buf) {
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'icns', 'icns magic 不符');
  const types = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    types.push(buf.subarray(off, off + 4).toString('ascii'));
    off += buf.readUInt32BE(off + 4);
  }
  return types;
}

test('icon.ico 必须包含 NSIS 要求的 256x256 层', () => {
  const entries = parseIcoEntries(readFileSync(join(buildDir, 'icon.ico')));
  const has256 = entries.some((e) => e.width === 256 && e.height === 256);
  assert.ok(has256, `icon.ico 缺少 256x256 层（实际: ${entries.map((e) => `${e.width}x${e.height}`).join(', ')}）— NSIS 打包会失败`);
});

test('icon.ico 覆盖 16–256 全尺寸，供 rcedit 嵌入 exe 各 DPI 使用', () => {
  const entries = parseIcoEntries(readFileSync(join(buildDir, 'icon.ico')));
  const sizes = new Set(entries.map((e) => e.width));
  for (const expected of [16, 24, 32, 48, 64, 128, 256]) {
    assert.ok(sizes.has(expected), `icon.ico 缺少 ${expected}px 层（实际: ${[...sizes].join(', ')}）`);
  }
});

test('icon.icns 包含 mac 打包所需的 256/512/1024 大尺寸层', () => {
  const types = parseIcnsTypes(readFileSync(join(buildDir, 'icon.icns')));
  for (const required of ['ic08', 'ic09', 'ic10']) {
    assert.ok(types.includes(required), `icon.icns 缺少 ${required} 层（实际: ${types.join(', ')}）`);
  }
});
