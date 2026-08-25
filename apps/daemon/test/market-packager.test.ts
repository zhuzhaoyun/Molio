// apps/daemon/test/market-packager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { packVaultToZip } from '../src/core/market/packager.js';

function makeVault(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-pack-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return dir;
}

function listEntries(zipBytes: Uint8Array): string[] {
  const entries: string[] = [];
  const uz = new Unzip((file) => { entries.push(file.name); file.ondata = () => {}; });
  uz.push(zipBytes, true);
  return entries.sort();
}

test('打包：普通文件入包；隐藏文件/目录与系统垃圾排除', async () => {
  const dir = makeVault({
    'a.md': 'A',
    'sub/b.md': 'B',
    '.obsidian/config.json': 'X',
    '.molio/cache': 'X',
    'sub/.hidden.md': 'X',
    'Thumbs.db': 'X',
    'sub/desktop.ini': 'X',
  });
  const { zipPath, size, dispose } = await packVaultToZip(dir, { maxBytes: 50 * 1024 * 1024 });
  const buf = new Uint8Array(fs.readFileSync(zipPath));
  assert.deepEqual(listEntries(buf), ['a.md', 'sub/b.md']);
  assert.ok(size > 0);
  dispose();
  assert.equal(fs.existsSync(zipPath), false);
});

test('超大小上限 → 报错 zip_too_large', async () => {
  // 随机字节不可压缩：压缩后门控必须用随机数据才能触发（'x'.repeat 会被 deflate 压到远小于上限）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-pack-'));
  fs.writeFileSync(path.join(dir, 'big.bin'), randomBytes(4096));
  await assert.rejects(
    packVaultToZip(dir, { maxBytes: 1024 }),
    (e: unknown) => (e as Error).message.includes('zip_too_large'),
  );
});

test('目录不存在 → 报错', async () => {
  await assert.rejects(packVaultToZip(path.join(os.tmpdir(), 'nope-xyz'), { maxBytes: 1024 }));
});
