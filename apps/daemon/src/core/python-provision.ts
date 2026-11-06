/**
 * python-provision.ts — 自动供给独立 Python 运行环境（docling 免装 Python）。
 *
 * 背景：docling 预下载原本要求本机已有 Python ≥3.10，找不到就报错让用户自己
 * 去 python.org/brew/winget 装——对非技术用户太繁琐。本模块在系统 Python 缺失
 * 时自动下载 python-build-standalone（PBS，uv/hermes 同款的免安装可重定位
 * CPython）解压到 `~/.molio/python/`，供 preload-manager 建 venv 使用。
 *
 * 源链（全实测 2026-09-28）：
 *   1. `MOLIO_PYTHON_MIRROR` env（若设，替换 npmmirror 位；目录结构须与
 *      npmmirror 的 PBS 镜像一致：`{base}/{tag}/{文件}` + JSON 目录列表）
 *   2. npmmirror（阿里云域名，国内快且信创内网通常放行）：
 *      `https://registry.npmmirror.com/-/binary/python-build-standalone/`
 *   3. GitHub releases pinned tag（海外用户/镜像不可达兜底；FALLBACK_TAG 需
 *      偶尔人工更新）
 *
 * 完整性：每个源都从同目录下载 `SHA256SUMS` 校验 archive 哈希——不匹配即换下
 * 一个源（镜像损坏/投毒防御）。SHA256SUMS 本身取不到时（自建镜像未同步）记
 * 警告继续，不阻断。
 *
 * 解压：必须用系统 tar（Win10+ 自带 tar.exe，POSIX 普适）——PBS 的 POSIX
 * archive 含 symlink，install.ts 的内存式 extractTreeFromTarball 不建链接且
 * ~150MB 解包全进内存，不可用于此。
 *
 * 布局：archive 顶层是 `python/`，用 `--strip-components=1` 解到 staging 后，
 * 解释器在 `<root>/python.exe`（win）/ `<root>/bin/python3`（posix）。换位用
 * install.ts 同款原子模式：staging 验证通过 → rm 旧 root → rename。
 *
 * 测试 seam：PythonProvisionDeps 全 side-effect 可注入（仿 install.ts 的
 * ScriptInstallDeps），单测零真实网络。
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** Pin 3.12 minor：torch/docling 对 3.12 兼容最稳（3.13+ 仍脆弱）。patch 动态取最新。 */
export const PBS_PY_MINOR = '3.12';

/** GitHub pinned 兜底：npmmirror 不可达时用这组已验证存在的 tag+版本。
 *  升级方法：浏览 https://github.com/astral-sh/python-build-standalone/releases
 *  取最新 tag 及其 3.12.x 版本号，两个常量一起改。 */
export const FALLBACK_TAG = '20260924';
export const FALLBACK_PY_VERSION = '3.12.14';

export const NPMMIRROR_BASE = 'https://registry.npmmirror.com/-/binary/python-build-standalone';
export const GITHUB_BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download';

/** archive 下载上限（stripped ~22MB / full ~47MB；防 captive-portal 大页面/镜像异常）。 */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** 单请求整体超时（含下载）。 */
const REQUEST_TIMEOUT_MS = 600_000;
/** JSON/SHA256SUMS 小请求超时。 */
const SMALL_TIMEOUT_MS = 30_000;

export class PythonProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonProvisionError';
  }
}

// ─── 路径 ────────────────────────────────────────────────────────────────────

/** 每次调用实时解析（os.homedir 吃 HOME/USERPROFILE env——测试靠覆盖它们隔离）。
 *  与 venvRoot/getMolioBinDir 同约定：os.homedir()，不吃 MOLIO_DATA_DIR。 */
export function managedPythonRoot(): string {
  return path.join(os.homedir(), '.molio', 'python');
}

export function managedPythonExe(): string {
  return process.platform === 'win32'
    ? path.join(managedPythonRoot(), 'python.exe')
    : path.join(managedPythonRoot(), 'bin', 'python3');
}

/** staging 目录名（stop 清理扫这个前缀删残留）。 */
export function managedPythonStagingPrefix(): string {
  return 'python.staging-';
}

/** 已装且能跑 → 返回解释器路径；否则 null。stat 不够——解压损坏/截断要靠
 *  `--version` 试运行才暴露。runner 可注入（测试）。 */
export function resolveManagedPython(
  runner?: (exe: string) => string | null,
): string | null {
  const exe = managedPythonExe();
  if (!fs.existsSync(exe)) return null;
  const run = runner ?? defaultInterpreterRunner;
  const out = run(exe);
  return out && /^Python\s+3\.(1[0-9]|[2-9]\d)/.test(out) ? exe : null;
}

function defaultInterpreterRunner(exe: string): string | null {
  try {
    return execFileSync(exe, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// ─── 平台映射 ────────────────────────────────────────────────────────────────

/** PBS target triple。参数化供测试；32 位/armv7/musl 等不支持的平台抛明确错误
 *  （musl 无法可靠探测——linux 一律按 gnu 供给，真跑不起来由解释器验证兜底）。 */
export function platformTriple(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  if (!a) {
    throw new PythonProvisionError(
      `不支持的 CPU 架构：${arch}。docling 自动准备 Python 仅支持 x64/arm64，请手动安装 Python 3.10+。`,
    );
  }
  if (platform === 'win32') return `${a}-pc-windows-msvc`;
  if (platform === 'darwin') return `${a}-apple-darwin`;
  if (platform === 'linux') return `${a}-unknown-linux-gnu`;
  throw new PythonProvisionError(
    `不支持的平台：${platform}。请手动安装 Python 3.10+ 后重试。`,
  );
}

// ─── 源与发现 ────────────────────────────────────────────────────────────────

interface PbsSource {
  label: string;
  /** listing = JSON 目录发现（npmmirror 及同款镜像）；pinned = GitHub 常量直拼。 */
  kind: 'listing' | 'pinned';
  base: string;
}

/** 源链：env 覆盖（替换 npmmirror 位）→ npmmirror → GitHub pinned。 */
export function buildSources(env: NodeJS.ProcessEnv = process.env): PbsSource[] {
  const custom = (env['MOLIO_PYTHON_MIRROR'] ?? '').trim().replace(/\/+$/, '');
  const sources: PbsSource[] = [];
  if (custom) {
    sources.push({ label: '自定义镜像', kind: 'listing', base: custom });
  } else {
    sources.push({ label: 'npmmirror 国内源', kind: 'listing', base: NPMMIRROR_BASE });
  }
  sources.push({ label: 'GitHub 官方源', kind: 'pinned', base: GITHUB_BASE });
  return sources;
}

/** 从 tag 目录的文件名列表里挑最优 archive：3.12 最高 patch，stripped 优先
 *  （22MB vs full 47MB），无匹配 → null。纯函数，export 供测试。 */
export function pickBestArchive(names: string[], triple: string): string | null {
  const esc = triple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const suffix of ['install_only_stripped', 'install_only']) {
    const rx = new RegExp(
      `^cpython-${PBS_PY_MINOR.replace('.', '\\.')}\\.(\\d+)\\+\\d{8}-${esc}-${suffix}\\.tar\\.gz$`,
    );
    let best: { name: string; patch: number } | null = null;
    for (const n of names) {
      const m = n.match(rx);
      const patch = m?.[1] ? Number(m[1]) : NaN;
      if (m && (!best || patch > best.patch)) best = { name: n, patch };
    }
    if (best) return best.name;
  }
  return null;
}

/** 解析 SHA256SUMS（标准 `<hash>  <文件名>` 格式，兼容单空格/`*` 二进制标记）。
 *  找不到该文件 → null。纯函数，export 供测试。 */
export function parseSha256sums(text: string, filename: string): string | null {
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m && m[2] === filename) return m[1]!.toLowerCase();
  }
  return null;
}

interface ResolvedArchive {
  tag: string;
  filename: string;
  url: string;
  sumsUrl: string;
}

/** 解析 npmmirror 风格的 JSON 目录列表（[{name,size,...}]，目录名带尾斜杠），
 *  宽容处理纯字符串数组。解析失败抛错（换下一个源）。 */
function parseListingNames(text: string): string[] {
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new PythonProvisionError('镜像目录列表不是合法 JSON');
  }
  if (!Array.isArray(arr)) throw new PythonProvisionError('镜像目录列表格式异常');
  const names: string[] = [];
  for (const e of arr) {
    const n = typeof e === 'string' ? e : (e as { name?: unknown })?.name;
    if (typeof n === 'string' && n) names.push(n.replace(/\/$/, ''));
  }
  return names;
}

// ─── 网络 + 解压默认实现 ─────────────────────────────────────────────────────

function composeSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function httpGetText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal: composeSignal(signal, SMALL_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new PythonProvisionError(`HTTP ${res.status} @ ${url}`);
  return res.text();
}

async function httpGetBuffer(
  url: string,
  signal?: AbortSignal,
  onBytes?: (done: number, total: number | null) => void,
): Promise<Buffer> {
  const res = await fetch(url, { signal: composeSignal(signal), redirect: 'follow' });
  if (!res.ok) throw new PythonProvisionError(`HTTP ${res.status} @ ${url}`);
  const totalHdr = res.headers.get('content-length');
  const total = totalHdr ? Number(totalHdr) : null;
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    onBytes?.(buf.length, total);
    return buf;
  }
  const chunks: Buffer[] = [];
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    if (value) {
      done += value.length;
      if (done > MAX_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new PythonProvisionError(`下载超过 ${MAX_ARCHIVE_BYTES} 上限，疑似镜像异常`);
      }
      chunks.push(Buffer.from(value));
      onBytes?.(done, total);
    }
  }
  return Buffer.concat(chunks);
}

/** 系统 tar 解压（symlink 保真；Win10+ 自带 tar.exe）。
 *  ⚠️ Windows 盘符陷阱：GNU tar（msys/Git Bash）与 bsdtar 的 `-f` 都支持
 *  `host:path` 远程语法——`C:\...\x.tar.gz` 被误解析成「连接远程主机 C」
 *  （Cannot connect to C: resolve failed，真机验收 2026-09-29 抓到）。
 *  `--force-local` 只有 GNU tar 认、`@file` 两家语义不同——跨实现最稳的
 *  修法是 cwd 切到 archive 所在目录、只传无冒号的裸文件名（argv 数组无
 *  shell，空格路径同样安全）；`-C` 目标目录不吃 host:path 解析，可传绝对路径。
 *  Exported for tests（盘符回归用例要跑真 tar）。 */
export function systemTarExtract(archivePath: string, stagingDir: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', path.basename(archivePath), '-C', stagingDir, '--strip-components=1'], {
      cwd: path.dirname(archivePath),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-400); });
    const onAbort = () => { proc.kill('SIGKILL'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new PythonProvisionError(
        err.message.includes('ENOENT')
          ? '找不到系统 tar 命令（Windows 10+ 自带；更老的系统请手动安装 Python 3.10+）'
          : `tar 解压失败：${err.message}`,
      ));
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      if (code === 0) resolve();
      else reject(new PythonProvisionError(`tar 解压失败（退出码 ${code}）：${stderr.trim()}`));
    });
  });
}

// ─── 测试 seam ───────────────────────────────────────────────────────────────

export interface PythonProvisionDeps {
  /** 取 JSON 目录列表 / SHA256SUMS 文本。 */
  fetchText?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** 下载 archive 字节。 */
  download?: (url: string, signal?: AbortSignal, onBytes?: (done: number, total: number | null) => void) => Promise<Buffer>;
  /** 解压 tar.gz 到 staging 目录。 */
  extract?: (archivePath: string, stagingDir: string, signal?: AbortSignal) => Promise<void>;
  /** 跑 `<exe> --version`，返回 stdout（失败 null）。 */
  runInterpreter?: (exe: string) => Promise<string | null>;
  /** 已装检查（默认 resolveManagedPython，会真跑 --version）。 */
  isInstalled?: () => string | null;
}

export interface ProvisionOptions {
  signal: AbortSignal;
  /** pct 3-10 带宽（与 preload Phase 0→1 的进度衔接）。 */
  onProgress?: (pct: number, msg: string) => void;
  deps?: PythonProvisionDeps;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 供给独立 Python：已装则短路返回；否则按源链 发现→下载→sha256 校验→系统 tar
 * 解压到 staging→解释器试运行→原子换位到 ~/.molio/python。全部源失败抛
 * PythonProvisionError（带手动安装/镜像 hint）。abort 立即传播（pause/stop）。
 */
export async function provisionManagedPython(opts: ProvisionOptions): Promise<string> {
  const deps = opts.deps ?? {};
  const fetchText = deps.fetchText ?? httpGetText;
  const download = deps.download ?? httpGetBuffer;
  const extract = deps.extract ?? systemTarExtract;
  const runInterpreter = deps.runInterpreter ?? (async (exe) => defaultInterpreterRunner(exe));
  const { signal, onProgress } = opts;

  const existing = (deps.isInstalled ?? resolveManagedPython)();
  if (existing) return existing;

  const triple = platformTriple();
  const sources = buildSources();
  let lastErr: unknown = null;

  for (const source of sources) {
    if (signal.aborted) throw new Error('aborted');
    let tmpFile: string | null = null;
    let staging: string | null = null;
    try {
      onProgress?.(3, `正在查询 ${source.label}...`);
      const resolved = source.kind === 'listing'
        ? await discoverFromListing(source.base, triple, fetchText, signal)
        : pinnedGithubArchive();
      if (!resolved) {
        lastErr = new PythonProvisionError(`${source.label} 没有 ${PBS_PY_MINOR} 的 ${triple} 包`);
        onProgress?.(3, `${source.label} 未找到匹配包，换下一个源...`);
        continue;
      }

      // SHA256SUMS：取到就强校验；取不到（自建镜像未同步）记警告继续。
      let expectedSha: string | null = null;
      try {
        const sums = await fetchText(resolved.sumsUrl, signal);
        expectedSha = parseSha256sums(sums, resolved.filename);
      } catch {
        onProgress?.(3, '该源未提供 SHA256SUMS，跳过完整性校验');
      }

      onProgress?.(3, `正在下载独立 Python 运行环境（${source.label}）...`);
      let lastMb = -1;
      const archive = await download(resolved.url, signal, (done, total) => {
        const mb = Math.floor(done / 1e6);
        if (mb !== lastMb) {
          lastMb = mb;
          const totalMb = total ? `/${Math.round(total / 1e6)}MB` : '';
          onProgress?.(3 + Math.min(6, Math.floor(total ? (done / total) * 6 : 3)),
            `正在下载独立 Python 运行环境... ${mb}${totalMb} MB`);
        }
      });

      if (expectedSha) {
        onProgress?.(9, '正在校验 SHA256...');
        const actual = crypto.createHash('sha256').update(archive).digest('hex');
        if (actual !== expectedSha) {
          throw new PythonProvisionError(
            `SHA256 校验失败（期望 ${expectedSha.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），疑似镜像损坏`,
          );
        }
      }

      tmpFile = path.join(os.tmpdir(), `molio-pbs-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
      fs.writeFileSync(tmpFile, archive);

      onProgress?.(10, '正在解压 Python 运行环境...');
      staging = path.join(os.homedir(), '.molio', `${managedPythonStagingPrefix()}${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(staging, { recursive: true });
      await extract(tmpFile, staging, signal);

      onProgress?.(10, '正在验证 Python 解释器...');
      const stagingExe = process.platform === 'win32'
        ? path.join(staging, 'python.exe')
        : path.join(staging, 'bin', 'python3');
      const verOut = await runInterpreter(stagingExe);
      if (!verOut || !new RegExp(`^Python\\s+${PBS_PY_MINOR.replace('.', '\\.')}\\.`).test(verOut)) {
        throw new PythonProvisionError(
          `解压后的解释器无法运行${verOut ? `（输出异常：${verOut.slice(0, 80)}）` : ''}——平台可能不受支持（如 musl/老 Windows）`,
        );
      }

      // 原子换位（install.ts bundled 同款）：先删旧再 rename。
      const root = managedPythonRoot();
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(staging, root);
      staging = null; // 已换位成功，finally 不再清理

      onProgress?.(10, '独立 Python 运行环境就绪');
      return managedPythonExe();
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error('aborted');
      lastErr = err;
      const detail = err instanceof Error ? err.message : String(err);
      onProgress?.(3, `${source.label}失败（${detail.slice(0, 120)}），换下一个源...`);
    } finally {
      if (tmpFile) { try { fs.rmSync(tmpFile, { force: true }); } catch { /* best effort */ } }
      if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }

  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误');
  throw new PythonProvisionError(
    `自动下载独立 Python 失败：${detail}。可：① 检查网络/代理后重试；` +
    `② 内网/自建镜像设 MOLIO_PYTHON_MIRROR 环境变量（目录结构同 npmmirror 的 python-build-standalone 镜像）；` +
    `③ 手动安装 Python 3.10+（python.org / brew / winget）后重试。`,
  );
}

/** listing 源发现：最新 3 个 tag 里找匹配包（最新 tag 可能还没同步全文件）。 */
async function discoverFromListing(
  base: string,
  triple: string,
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<ResolvedArchive | null> {
  const tagText = await fetchText(`${base}/`, signal);
  const tags = parseListingNames(tagText)
    .filter((n) => /^\d{8}$/.test(n))
    .sort();
  for (const tag of tags.slice(-3).reverse()) {
    let names: string[];
    try {
      names = parseListingNames(await fetchText(`${base}/${tag}/`, signal));
    } catch {
      continue; // 该 tag 目录读不了，试下一个
    }
    const filename = pickBestArchive(names, triple);
    if (filename) {
      return { tag, filename, url: `${base}/${tag}/${filename}`, sumsUrl: `${base}/${tag}/SHA256SUMS` };
    }
  }
  return null;
}

/** GitHub pinned：tag+版本是常量，直接拼 URL。只用 stripped 变体——PBS 每个
 *  tag 对全部六个 triple 都发布 stripped 包（已核实 20260924）。404/失败由主
 *  流程的换源逻辑处理。 */
function pinnedGithubArchive(): ResolvedArchive | null {
  const triple = platformTriple();
  const filename = `cpython-${FALLBACK_PY_VERSION}+${FALLBACK_TAG}-${triple}-install_only_stripped.tar.gz`;
  return {
    tag: FALLBACK_TAG,
    filename,
    url: `${GITHUB_BASE}/${FALLBACK_TAG}/${filename}`,
    sumsUrl: `${GITHUB_BASE}/${FALLBACK_TAG}/SHA256SUMS`,
  };
}
