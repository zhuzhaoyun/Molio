/**
 * prebuild 下载源回退守护测试（错误驱动）。
 *
 * 背景：2026-09-19 本地打包时 prebuild-install 直连 GitHub releases 下载
 * better-sqlite3 Electron 预编译产物超时（3 次重试全挂），`pnpm package:dir`
 * 构建中断。实测 prebuild-install 7.x 的 --mirror 参数无效，正确机制是
 * npm_config_better_sqlite3_binary_host 环境变量覆盖下载 host。
 * 修复：GitHub → npmmirror 两级回退 + MOLIO_PREBUILD_HOST 显式指定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'prepare-resources.mjs'),
  'utf-8',
);

test('prebuild 下载使用 npm_config_better_sqlite3_binary_host 覆盖机制', () => {
  assert.ok(
    script.includes('npm_config_better_sqlite3_binary_host'),
    'prepare-resources 必须用 prebuild-install 认可的 binary_host 环境变量（--mirror 参数无效，实测）',
  );
});

test('GitHub 失败后自动回退 npmmirror 二进制镜像', () => {
  assert.ok(
    script.includes('https://registry.npmmirror.com/-/binary/better-sqlite3'),
    '缺少 npmmirror 回退源 — 国内/信创网络直连 GitHub releases 会超时',
  );
  assert.match(script, /trying next source/, '必须有跨来源的回退逻辑');
});

test('支持 MOLIO_PREBUILD_HOST 显式指定下载源并在报错提示中说明', () => {
  assert.ok(script.includes('MOLIO_PREBUILD_HOST'), '缺少 MOLIO_PREBUILD_HOST 显式指定入口');
  assert.match(script, /Tips:[\s\S]*MOLIO_PREBUILD_HOST/, '报错 Tips 必须告诉用户这个环境变量');
});
