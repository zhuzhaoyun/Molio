#!/usr/bin/env node
/**
 * 修复 electron 安装不完整的问题（nodejs/node#63487）
 *
 * 背景：Node.js >= 24.16.0（及 >= 26.1.0）破坏了 yauzl@2.x 的流式解压
 * （fd-slicer ReadStream → zlib inflate 管道停滞，进程静默以 0 退出），
 * 导致 electron 的 install.js 只解出 zip 第一个条目就结束：
 * dist/ 残缺、path.txt 缺失，运行时抛 "Electron failed to install correctly"。
 *
 * 本脚本在每次 `pnpm install` 后运行：
 *   - electron 完整时：毫秒级 no-op；
 *   - 检测到残缺时：用系统解压工具（unzip / bsdtar / PowerShell Expand-Archive）
 *     从 @electron/get 的缓存 zip 重新解压到 dist/ 并写入 path.txt。
 *
 * 依赖 system 解压工具而非 yauzl，因此不受该 Node 回归影响。
 * electron 升级到自带修复版（>= 42，改用 @electron-internal/extract-zip）后，
 * 本脚本自动变为 no-op，可直接删除。
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

function platformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      // linux / freebsd / openbsd
      return 'electron';
  }
}

/** 找到所有已安装的 electron 包目录（pnpm 的 .pnpm/electron* 目录下的 electron）。 */
function findElectronDirs() {
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return [];
  return readdirSync(pnpmDir)
    .filter((name) => name.startsWith('electron@'))
    .map((name) => join(pnpmDir, name, 'node_modules', 'electron'))
    .filter(existsSync);
}

/** 与 electron install.js 的 isInstalled() 相同：dist/version + path.txt + 可执行文件。 */
function isInstalled(electronDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
    const version = pkg.version;
    const versionFile = readFileSync(join(electronDir, 'dist', 'version'), 'utf8')
      .trim()
      .replace(/^v/, '');
    if (versionFile !== version) return false;
    const pathFile = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim();
    if (pathFile !== platformPath()) return false;
    return existsSync(join(electronDir, 'dist', platformPath()));
  } catch {
    return false;
  }
}

/**
 * 在 @electron/get 的缓存目录里找 electron-v<version>-*.zip，
 * 优先精确匹配 <platform>-<arch>，否则取同名任意平台。
 */
function findCachedZip(version) {
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) roots.push(process.env.ELECTRON_CACHE);
  if (process.platform === 'darwin') {
    roots.push(join(homedir(), 'Library', 'Caches', 'electron'));
  } else if (process.platform === 'win32') {
    roots.push(join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'));
  } else {
    roots.push(join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron'));
  }

  const wantExact = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const wantPrefix = `electron-v${version}-`;

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const fallback = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.startsWith(wantPrefix) && entry.name.endsWith('.zip')) {
          if (entry.name === wantExact) return full;
          fallback.push(full);
        }
      }
    }
    if (fallback.length > 0) return fallback[0];
  }
  return null;
}

/** 用系统解压工具把 zip 解到 destDir（先清空）。unzip → bsdtar → PowerShell。 */
function extractZip(zipPath, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const attempts = [];
  if (process.platform !== 'win32') {
    attempts.push(() => execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'pipe' }));
  }
  // macOS / Windows 自带 bsdtar，支持解压 zip；Linux 上 unzip 已先行。
  attempts.push(() => execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' }));
  attempts.push(() =>
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: 'pipe' }
    )
  );

  for (const attempt of attempts) {
    try {
      attempt();
      return;
    } catch {
      // 尝试下一个工具
    }
  }
  throw new Error('没有可用的解压工具（unzip / tar / Expand-Archive）');
}

function main() {
  const electronDirs = findElectronDirs();
  if (electronDirs.length === 0) return;

  let fixedAny = false;
  for (const dir of electronDirs) {
    if (isInstalled(dir)) continue; // 健康，no-op

    let version;
    try {
      version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    } catch {
      continue;
    }

    console.log(
      `[fix-electron] electron@${version} 安装不完整（Node >=24.16 的 yauzl 解压回归，见 nodejs/node#63487），尝试从缓存修复…`
    );
    const zip = findCachedZip(version);
    if (!zip) {
      console.warn(
        `[fix-electron] 未找到 electron-v${version} 的缓存 zip（一般在 ~/Library/Caches/electron 或 ~/.cache/electron）。` +
          '请先 `pnpm install` 触发下载后再重试。'
      );
      continue;
    }

    try {
      extractZip(zip, join(dir, 'dist'));
      writeFileSync(join(dir, 'path.txt'), platformPath());
    } catch (err) {
      console.warn(`[fix-electron] 修复失败：${err.message}`);
      continue;
    }

    if (isInstalled(dir)) {
      console.log(`[fix-electron] electron@${version} 已修复（从缓存 ${zip} 重新解压）。`);
      fixedAny = true;
    } else {
      console.warn(
        `[fix-electron] electron@${version} 修复后仍不完整，请手动执行 \`pnpm rebuild electron\`。`
      );
    }
  }
}

main();
