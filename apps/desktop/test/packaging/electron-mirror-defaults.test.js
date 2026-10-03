/**
 * electron-builder 镜像默认值守护测试（错误驱动）。
 *
 * 背景：2026-09 国内网络本地打包，electron-builder 直连 GitHub 下载
 * Electron 本体 zip 与 electron-builder-binaries（NSIS 等）超时，构建中断。
 * 修复：package.mjs 在两个镜像环境变量未设置时注入 npmmirror 默认值，
 * 且所有 electron-builder 入口（package / package:win|mac|linux /
 * package:dir / run:unpacked）统一走 package.mjs，保证默认值全覆盖。
 * CI release 工作流直接调用 npx electron-builder、不经此脚本，不受影响。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, '..', '..', 'scripts', 'package.mjs'), 'utf-8');
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));

test('package.mjs 内置 npmmirror 镜像默认值', () => {
  assert.ok(
    script.includes('https://cdn.npmmirror.com/binaries/electron/'),
    '缺少 ELECTRON_MIRROR 默认值 — 国内/信创网络直连 GitHub 下载 Electron zip 会超时',
  );
  assert.ok(
    script.includes('https://cdn.npmmirror.com/binaries/electron-builder-binaries/'),
    '缺少 ELECTRON_BUILDER_BINARIES_MIRROR 默认值 — NSIS 等构建期二进制直连 GitHub 会超时',
  );
});

test('镜像默认值不覆盖用户已显式设置的环境变量', () => {
  assert.match(
    script,
    /if \(!process\.env\[key\]\)/,
    '必须仅在未设置时注入默认值（遵循用户偏好处理规则，不得静默覆盖）',
  );
});

test('所有 electron-builder 入口统一走 package.mjs（默认值才全覆盖）', () => {
  for (const name of ['package', 'package:win', 'package:mac', 'package:linux', 'package:dir', 'run:unpacked']) {
    assert.ok(
      pkg.scripts[name].includes('node scripts/package.mjs'),
      `${name} 仍直接调用 electron-builder，镜像默认值不会生效`,
    );
  }
});
