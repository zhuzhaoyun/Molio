#!/usr/bin/env node
/**
 * deploy-package.mjs — 构建 apps/cloud 的 FC 部署 zip（第一期手动上传流程）。
 *
 * 背景（2026-08-24 线上 422 事故的打包教训，全部实测踩过，别重新考古）：
 *   函数形态：阿里云函数计算 FC，Web 函数（Custom Runtime），**单函数 prod**（cn-hangzhou），
 *   自定义域名 auth.molio.cn 直连 LATEST 版本（无版本/别名）。启动命令：
 *       /code/runtime/node /code/dist/src/index.js
 *   因此代码包必须自带 **linux-x64 Node 二进制**（runtime/node），且 node_modules
 *   必须是**扁平的真实目录树**——pnpm 符号链接布局经 zip 打平后依赖链断裂
 *   （报 Cannot find module 'pg-types'）。
 *
 * 用法（仓库根目录）：
 *   node apps/cloud/scripts/deploy-package.mjs                # tsc 构建 + 打包
 *   node apps/cloud/scripts/deploy-package.mjs --skip-build   # dist 已构建好时跳过 tsc
 *
 * 产物：apps/cloud/molio-cloud-deploy.zip（约 47MB）
 *
 * 上线步骤：
 *   1. 运行本脚本生成 zip
 *   2. 阿里云控制台 → 函数计算 → 函数 → 代码 → 上传 ZIP
 *      ⚠️ 上传代码包会强制所有常驻实例销毁重建——这也是清「老实例带旧环境变量」的
 *      唯一手段：FC 常驻实例不感知配置变更，**只改控制台环境变量不会生效**。
 *   3. 建议同步更新环境变量 DEPLOY_VERSION=<部署时间戳>，用于验证新实例已生效
 *   4. 验证（注意 60s 重发限频）：
 *        curl -X POST https://auth.molio.cn/auth/send-code \
 *          -H "Content-Type: application/json" -d '{"email":"<你的邮箱>"}'
 *      预期：HTTP 202，{"ok":true,"resendAfterSec":60}
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// ─── 常量 ────────────────────────────────────────────────────────────

/** 与线上函数一致的 Node 运行时版本（linux-x64）。升级须同步改函数启动命令验证。 */
const NODE_VERSION = 'v22.20.0';
/** 内网信创/无外网环境也放行的镜像源（见根 CLAUDE.md「信创原则」）。 */
const NODE_DIST_URL = `https://registry.npmmirror.com/-/binary/node/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.gz`;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.join(SCRIPT_DIR, '..');
const REPO_ROOT = path.join(CLOUD_DIR, '..', '..');
const STAGING = path.join(CLOUD_DIR, '.deploy-staging');
const RUNTIME_CACHE = path.join(CLOUD_DIR, '.runtime-cache');
const OUT_ZIP = path.join(CLOUD_DIR, 'molio-cloud-deploy.zip');
/** zip 内需要执行位的文件（0o755），其余 0o644。 */
const EXECUTABLES = new Set(['bootstrap', 'runtime/node']);

const SKIP_BUILD = process.argv.includes('--skip-build');

function log(msg) {
  console.log(`[deploy-package] ${msg}`);
}

function fail(msg) {
  console.error(`[deploy-package] ✘ ${msg}`);
  process.exit(1);
}

// ─── 1. TypeScript 构建 ─────────────────────────────────────────────

function build() {
  if (SKIP_BUILD) {
    log('跳过构建（--skip-build）');
    if (!fs.existsSync(path.join(CLOUD_DIR, 'dist', 'src', 'index.js'))) {
      fail('dist/src/index.js 不存在，去掉 --skip-build 重跑');
    }
    return;
  }
  // 直接调根目录 typescript，绕开 pnpm pre-script 在本机的抽风（verify-deps 误清 node_modules）
  const tscJs = path.join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!fs.existsSync(tscJs)) fail(`找不到 ${tscJs}，先在仓库根执行 pnpm install`);
  log('tsc 构建 apps/cloud ...');
  try {
    execFileSync(process.execPath, [tscJs, '-p', CLOUD_DIR], { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch {
    fail('tsc 构建失败，先看上方编译错误');
  }
}

// ─── 2. staging：package.json + 扁平 node_modules + dist/src ────────

function prepareStaging() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });

  // package.json：只留运行时依赖；@molio/contracts 是 workspace:* 且仅类型导入，运行时不需要
  const pkg = JSON.parse(fs.readFileSync(path.join(CLOUD_DIR, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  if (pkg.dependencies) delete pkg.dependencies['@molio/contracts'];
  fs.writeFileSync(path.join(STAGING, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  // npm（非 pnpm）装出扁平 hoisted 依赖树
  log('npm install --omit=dev（扁平依赖树，可能耗时一两分钟）...');
  try {
    execSync('npm install --omit=dev --no-audit --no-fund', { cwd: STAGING, shell: true, stdio: 'inherit' });
  } catch {
    fail('npm install 失败');
  }
  fs.rmSync(path.join(STAGING, 'package-lock.json'), { force: true });

  // 产物只要 dist/src（启动命令 /code/dist/src/index.js），测试编译产物不进包
  fs.cpSync(path.join(CLOUD_DIR, 'dist', 'src'), path.join(STAGING, 'dist', 'src'), { recursive: true });

  // FC Custom Runtime 约定入口（虽然启动命令直连 node，但控制台探活/本地引导仍看它）
  fs.writeFileSync(
    path.join(STAGING, 'bootstrap'),
    '#!/bin/bash\n# FC Custom Runtime 入口：启动 HTTP server，监听 FC 注入的 PORT/CAPort\nexec node dist/src/index.js\n',
  );
}

// ─── 3. linux-x64 Node 运行时（缓存优先） ───────────────────────────

function download(url, dest, redirects = 0) {
  if (redirects > 5) throw new Error('重定向次数过多');
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'molio-deploy-package' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
          res.resume();
          resolve(download(new URL(res.headers.location ?? '', url).toString(), dest, redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        const tmp = `${dest}.part`;
        const ws = fs.createWriteStream(tmp);
        res.pipe(ws);
        ws.on('finish', () => {
          ws.close();
          fs.renameSync(tmp, dest);
          resolve(undefined);
        });
        ws.on('error', reject);
      })
      .on('error', reject);
  });
}

async function prepareRuntime() {
  fs.mkdirSync(RUNTIME_CACHE, { recursive: true });
  const cachedBin = path.join(RUNTIME_CACHE, `node-${NODE_VERSION}-linux-x64`);
  if (!fs.existsSync(cachedBin)) {
    const tarball = `${cachedBin}.tar.gz`;
    if (!fs.existsSync(tarball)) {
      log(`下载 Node ${NODE_VERSION} linux-x64（npmmirror，约 45MB）...`);
      try {
        await download(NODE_DIST_URL, tarball);
      } catch (err) {
        fs.rmSync(tarball, { force: true });
        fail(`Node 运行时下载失败：${err.message}（可手动下载后放到 ${tarball}）`);
      }
    }
    log('解出 bin/node ...');
    try {
      // 只解单个成员；-C 指定目录，成员路径须与 tar 内一致
      execSync(`tar -xzf "${tarball}" -C "${RUNTIME_CACHE}" "node-${NODE_VERSION}-linux-x64/bin/node"`, {
        shell: true,
        stdio: 'pipe',
      });
    } catch {
      fail(`tar 解包失败：${tarball} 可能损坏，删掉它重跑`);
    }
    fs.renameSync(path.join(RUNTIME_CACHE, `node-${NODE_VERSION}-linux-x64`, 'bin', 'node'), cachedBin);
    fs.rmSync(path.join(RUNTIME_CACHE, `node-${NODE_VERSION}-linux-x64`), { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  } else {
    log(`使用缓存 Node 运行时：${cachedBin}`);
  }
  fs.mkdirSync(path.join(STAGING, 'runtime'), { recursive: true });
  fs.copyFileSync(cachedBin, path.join(STAGING, 'runtime', 'node'));
}

// ─── 4. zip 写入（手写，Windows 上保住 Unix 执行位） ─────────────────
//
// 为什么不用现成工具：
//  - Git Bash 的 `tar -a -c -f x.zip` 在这个 libarchive 构建上**静默输出 tar**（FC 报 Invalid zip file）
//  - Windows 产出的 zip 条目 create_system=0（DOS），external_attr 被当 DOS 属性，
//    Unix 权限位不被解释 → bootstrap/runtime/node 没执行位（FC 报 CAFilePermission）
// 所以：条目必须 create_system=3（Unix）+ 完整模式位（含文件类型位 0o100xxx）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
  }

  #pushEntry(nameBuf, { time, date }, method, crc, csize, usize, mode) {
    if (this.count >= 0xffff) fail('条目数超出 zip32 上限');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0（deflate）
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(csize, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    this.chunks.push(local, nameBuf);
    this.offset += local.length + nameBuf.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // ← create_system=3（Unix），执行位生效的前提
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(csize, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); // external_attr：高 16 位 = Unix 模式
    central.writeUInt32LE(this.offset - local.length - nameBuf.length, 42);
    this.central.push(central, nameBuf);
    this.count++;
  }

  addFile(rel, data) {
    const compressed = zlib.deflateRawSync(data);
    const { time, date } = dosDateTime();
    const mode = EXECUTABLES.has(rel) ? 0o100755 : 0o100644;
    this.#pushEntry(Buffer.from(rel, 'utf8'), { time, date }, 8, crc32(data), compressed.length, data.length, mode);
    this.chunks.push(compressed);
    this.offset += compressed.length;
    if (this.offset > 0xff000000) fail('产物超出 zip32 上限，该上 zip64 了');
  }

  addDir(rel) {
    const { time, date } = dosDateTime();
    this.#pushEntry(Buffer.from(`${rel}/`, 'utf8'), { time, date }, 0, 0, 0, 0, 0o040755);
  }

  finish() {
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const c of this.central) {
      this.chunks.push(c);
      cdSize += c.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    this.chunks.push(eocd);
    return Buffer.concat(this.chunks);
  }
}

/** 深度遍历（statSync 跟随 junction/符号链接，npm 扁平树里都是真实文件）。 */
function* walk(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      yield { rel, dir: true };
      yield* walk(full, base);
    } else if (st.isFile()) {
      yield { rel, dir: false };
    } else {
      fail(`无法打包的条目类型：${full}`);
    }
  }
}

function makeZip() {
  log('扫描 staging 并写 zip（create_system=3 + 权限位）...');
  const zip = new ZipWriter();
  let bytes = 0;
  for (const { rel, dir } of walk(STAGING)) {
    if (dir) {
      zip.addDir(rel);
      continue;
    }
    const data = fs.readFileSync(path.join(STAGING, rel));
    zip.addFile(rel, data);
    bytes += data.length;
  }
  const buf = zip.finish();
  fs.writeFileSync(OUT_ZIP, buf);
  log(`zip 完成：${zip.count} 条目，未压缩 ${(bytes / 1024 / 1024).toFixed(1)}MB → 压缩后 ${(
    buf.length / 1024 / 1024
  ).toFixed(1)}MB`);
}

// ─── 5. 自检（python zipfile；不行再退 tar -tf） ────────────────────

function validate() {
  const py = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    "assert bad is None, f'corrupt entry: {bad}'",
    "names = z.namelist()",
    "missing = [n for n in ('bootstrap', 'runtime/node', 'dist/src/index.js', 'package.json') if n not in names]",
    "assert not missing, f'missing: {missing}'",
    "for req in ('bootstrap', 'runtime/node'):",
    '    info = z.getinfo(req)',
    "    assert info.create_system == 3, f'{req} create_system={info.create_system} (must be 3/Unix)'",
    '    mode = info.external_attr >> 16',
    "    assert mode & 0o111, f'{req} mode={oct(mode)} lacks exec bit'",
    "print(f'OK entries={len(names)}')",
  ].join('\n');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      execFileSync(cmd, ['-c', py, OUT_ZIP], { stdio: 'inherit' });
      log('zip 自检通过（python zipfile）✔');
      return;
    } catch (err) {
      if (err.code === 'ENOENT') continue; // 该命令不存在，换下一个
      fail('zip 自检失败：条目损坏或权限位缺失（见上方断言）');
    }
  }
  // 没有 python：至少确认 tar 能列出条目
  try {
    const out = execSync(`tar -tf "${OUT_ZIP}" | head -5`, { shell: true }).toString();
    log(`未找到 python，仅做列表自检：\n${out}`);
  } catch {
    fail('zip 自检不可用，请手工确认产物');
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────────

build();
prepareStaging();
await prepareRuntime();
makeZip();
validate();

log('');
log(`产物：${OUT_ZIP}`);
log('下一步：');
log('  1. 阿里云控制台 → 函数计算 → 函数 → 代码 → 上传 ZIP（强制实例换新）');
log('  2. 更新环境变量 DEPLOY_VERSION=<时间戳> 验证新实例生效');
log('  3. curl -X POST https://auth.molio.cn/auth/send-code -H "Content-Type: application/json" \\');
log('       -d \'{"email":"<你的邮箱>"}\'   # 预期 202 {"ok":true,"resendAfterSec":60}，注意 60s 限频');
