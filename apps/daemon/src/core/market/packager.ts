// apps/daemon/src/core/market/packager.ts
// vault → zip（fflate，daemon 已有依赖）。排除规则（设计 §5.1）：
// 任意层级隐藏文件/目录（'.' 开头）+ Thumbs.db/desktop.ini；任一文件读取失败阻断报错。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';

const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini']);

export interface PackResult {
  zipPath: string;
  size: number;
  /** 删除临时文件（发布完成/失败都要调用） */
  dispose: () => void;
}

function isExcluded(name: string): boolean {
  return name.startsWith('.') || JUNK_FILES.has(name.toLowerCase());
}

function collect(dir: string, prefix: string, out: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collect(abs, rel, out);
    } else if (entry.isFile()) {
      // 同步读取：50MB 上限内内存可控（设计 §十五风险 2）；读取失败直接抛出（阻断）
      out[rel] = abs;
    }
  }
}

export async function packVaultToZip(vaultPath: string, opts: { maxBytes: number }): Promise<PackResult> {
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(`vault_not_found: ${vaultPath}`);
  }
  const files: Record<string, string> = {};
  collect(vaultPath, '', files);

  const zippable: Zippable = {};
  for (const [rel, abs] of Object.entries(files)) {
    zippable[rel] = new Uint8Array(fs.readFileSync(abs));
  }
  const zipped = zipSync(zippable, { level: 6 });
  if (zipped.byteLength > opts.maxBytes) {
    throw new Error(`zip_too_large: ${zipped.byteLength} > ${opts.maxBytes}`);
  }
  const zipPath = path.join(os.tmpdir(), `molio-market-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(zipPath, zipped);
  return { zipPath, size: zipped.byteLength, dispose: () => fs.rmSync(zipPath, { force: true }) };
}
