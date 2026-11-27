#!/usr/bin/env node
/**
 * Cross-platform packaging script.
 * Detects the current OS and runs the appropriate electron-builder command.
 *
 * Usage: pnpm package
 * Or specify a platform: pnpm package:win | pnpm package:mac | pnpm package:linux
 * Extra args are forwarded to electron-builder (e.g. package:dir → --dir).
 */

import { execSync } from 'node:child_process';

// 国内/信创网络默认值兜底：electron-builder 打包时要下载两类构建期二进制——
// Electron 本体 zip 和 electron-builder-binaries（NSIS、winCodeSign 等），
// 默认源都在 GitHub，国内/信创网络直连普遍超时（实测 electron-builder-binaries
// 直连 github.com 下载必然卡死）。未显式配置时默认走 npmmirror 镜像，与
// prepare-resources.mjs 的 prebuild npmmirror 回退、install.sh 的国内源优先
// 原则一致。已显式设置的值一律尊重、绝不覆盖；CI 的 release 工作流直接调用
// `npx electron-builder`、不经过本脚本，发布产物的下载来源不受此默认值影响。
const MIRROR_DEFAULTS = {
  ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://cdn.npmmirror.com/binaries/electron-builder-binaries/',
};
for (const [key, value] of Object.entries(MIRROR_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = value;
    console.log(`  ${key} 未设置，默认使用 npmmirror 镜像: ${value}`);
  }
}

const platform = process.platform;
const extraArgs = process.argv.slice(2);
const hasPlatformFlag = extraArgs.some((a) => ['--win', '--mac', '--linux'].includes(a));

let target;
if (hasPlatformFlag) {
  target = extraArgs.join(' ');
} else {
  let flag;
  switch (platform) {
    case 'win32':
      flag = '--win';
      console.log('🪟 Packaging for Windows...');
      break;
    case 'darwin':
      flag = '--mac';
      console.log('🍎 Packaging for macOS...');
      break;
    case 'linux':
      flag = '--linux';
      console.log('🐧 Packaging for Linux...');
      break;
    default:
      console.error(`❌ Unsupported platform: ${platform}`);
      process.exit(1);
  }
  target = [flag, ...extraArgs].join(' ');
}

try {
  execSync(`electron-builder ${target}`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  console.log('✅ Packaging complete!');
} catch (err) {
  console.error('❌ Packaging failed:', err.message);
  process.exit(1);
}
