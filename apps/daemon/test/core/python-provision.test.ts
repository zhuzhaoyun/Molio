import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * python-provision.ts — docling 免装 Python 的自动供给模块。
 *
 * 全部走 PythonProvisionDeps seam 注入（仿 install.test.ts 的
 * ScriptInstallDeps 模式），零真实网络、零真实 tar。HOME/USERPROFILE 覆盖
 * tmpdir 隔离磁盘副作用（与 preload-manager.test.ts 同款）。
 *
 * 钉住的关键语义：
 * - 源链顺序：MOLIO_PYTHON_MIRROR env → npmmirror → GitHub pinned tag
 * - SHA256SUMS 强校验：哈希不匹配 = 换下一个源（镜像损坏/投毒防御）
 * - 原子换位：staging 验证通过才动 root；任何失败不清已有 root
 * - abort 立即传播 + 临时文件/staging 全清理
 * - 已装短路：零网络调用（重启幂等）
 */

const isWindows = process.platform === 'win32';

let savedHome: string | undefined;
let savedMirror: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedHome = isWindows ? process.env['USERPROFILE'] : process.env['HOME'];
  savedMirror = process.env['MOLIO_PYTHON_MIRROR'];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-pyprov-'));
  if (isWindows) process.env['USERPROFILE'] = tmpHome;
  else process.env['HOME'] = tmpHome;
  delete process.env['MOLIO_PYTHON_MIRROR'];
});

afterEach(() => {
  if (savedHome !== undefined) {
    if (isWindows) process.env['USERPROFILE'] = savedHome;
    else process.env['HOME'] = savedHome;
  } else {
    if (isWindows) delete process.env['USERPROFILE'];
    else delete process.env['HOME'];
  }
  if (savedMirror !== undefined) process.env['MOLIO_PYTHON_MIRROR'] = savedMirror;
  else delete process.env['MOLIO_PYTHON_MIRROR'];
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** staging/root 里的解释器相对路径（PBS strip 后布局）。 */
function exeRel(): string {
  return isWindows ? 'python.exe' : path.join('bin', 'python3');
}

// ─── 1. platformTriple ──────────────────────────────────────────────────────

describe('platformTriple (PBS target triple 映射)', () => {
  it('maps the six supported platform/arch pairs', async () => {
    const { platformTriple } = await import('../../src/core/python-provision.js');
    assert.equal(platformTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
    assert.equal(platformTriple('win32', 'arm64'), 'aarch64-pc-windows-msvc');
    assert.equal(platformTriple('darwin', 'x64'), 'x86_64-apple-darwin');
    assert.equal(platformTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.equal(platformTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
    assert.equal(platformTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
  });

  it('throws a clear PythonProvisionError on unsupported arch/platform', async () => {
    const { platformTriple, PythonProvisionError } = await import('../../src/core/python-provision.js');
    assert.throws(() => platformTriple('win32', 'ia32'), (err: unknown) => {
      assert.ok(err instanceof PythonProvisionError);
      assert.match((err as Error).message, /不支持的 CPU 架构/);
      assert.match((err as Error).message, /手动安装 Python/);
      return true;
    });
    assert.throws(() => platformTriple('freebsd', 'x64'), (err: unknown) => {
      assert.ok(err instanceof PythonProvisionError);
      assert.match((err as Error).message, /不支持的平台/);
      return true;
    });
  });
});

// ─── 2. pickBestArchive ─────────────────────────────────────────────────────

describe('pickBestArchive (3.12 pin + stripped 优先 + 最高 patch)', () => {
  it('picks the highest 3.12 patch among stripped archives', async () => {
    const { pickBestArchive, platformTriple } = await import('../../src/core/python-provision.js');
    const t = platformTriple();
    const names = [
      'SHA256SUMS',
      `cpython-3.12.13+20260924-${t}-install_only_stripped.tar.gz`,
      `cpython-3.12.14+20260924-${t}-install_only_stripped.tar.gz`,
      `cpython-3.12.2+20260924-${t}-install_only_stripped.tar.gz`,
    ];
    assert.equal(
      pickBestArchive(names, t),
      `cpython-3.12.14+20260924-${t}-install_only_stripped.tar.gz`,
    );
  });

  it('prefers stripped over full even when full has a higher patch', async () => {
    const { pickBestArchive, platformTriple } = await import('../../src/core/python-provision.js');
    const t = platformTriple();
    const names = [
      `cpython-3.12.14+20260924-${t}-install_only.tar.gz`,
      `cpython-3.12.13+20260924-${t}-install_only_stripped.tar.gz`,
    ];
    assert.equal(
      pickBestArchive(names, t),
      `cpython-3.12.13+20260924-${t}-install_only_stripped.tar.gz`,
      'stripped (22MB) must win over full (47MB)',
    );
  });

  it('falls back to the full install_only archive when no stripped exists', async () => {
    const { pickBestArchive, platformTriple } = await import('../../src/core/python-provision.js');
    const t = platformTriple();
    const names = [`cpython-3.12.14+20260924-${t}-install_only.tar.gz`];
    assert.equal(
      pickBestArchive(names, t),
      `cpython-3.12.14+20260924-${t}-install_only.tar.gz`,
    );
  });

  it('ignores other minors, other triples, other suffixes → null', async () => {
    const { pickBestArchive, platformTriple } = await import('../../src/core/python-provision.js');
    const t = platformTriple();
    const names = [
      `cpython-3.13.1+20260924-${t}-install_only_stripped.tar.gz`, // wrong minor
      `cpython-3.11.9+20260924-${t}-install_only_stripped.tar.gz`, // wrong minor
      `cpython-3.12.14+20260924-riscv64-unknown-linux-gnu-install_only_stripped.tar.gz`, // wrong triple
      `cpython-3.12.14+20260924-${t}-debuginfo.tar.gz`, // wrong suffix
      'SHA256SUMS',
      'README.md',
    ];
    assert.equal(pickBestArchive(names, t), null);
    assert.equal(pickBestArchive([], t), null);
  });
});

// ─── 3. parseSha256sums ─────────────────────────────────────────────────────

describe('parseSha256sums (标准 <hash>  <文件名> 解析)', () => {
  it('finds the hash for the exact filename and lowercases it', async () => {
    const { parseSha256sums } = await import('../../src/core/python-provision.js');
    const h = 'A'.repeat(64);
    const text = [
      `${'0'.repeat(64)}  other-file.tar.gz`,
      `${h}  cpython-3.12.14+20260924-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
      'garbage line',
    ].join('\n');
    assert.equal(
      parseSha256sums(text, 'cpython-3.12.14+20260924-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'),
      h.toLowerCase(),
    );
  });

  it('accepts the binary-marker (*) form and single spaces', async () => {
    const { parseSha256sums } = await import('../../src/core/python-provision.js');
    const h = 'ab'.repeat(32);
    assert.equal(parseSha256sums(`${h} *pkg.tar.gz`, 'pkg.tar.gz'), h);
    assert.equal(parseSha256sums(`${h} pkg.tar.gz`, 'pkg.tar.gz'), h);
  });

  it('returns null when the filename is absent or hash malformed', async () => {
    const { parseSha256sums } = await import('../../src/core/python-provision.js');
    assert.equal(parseSha256sums(`${'0'.repeat(64)}  a.tar.gz`, 'b.tar.gz'), null);
    assert.equal(parseSha256sums('tooshort  b.tar.gz', 'b.tar.gz'), null);
    assert.equal(parseSha256sums('', 'b.tar.gz'), null);
  });
});

// ─── 4. buildSources (源链顺序) ─────────────────────────────────────────────

describe('buildSources (env 覆盖 → npmmirror → GitHub pinned)', () => {
  it('default chain: npmmirror listing first, GitHub pinned last', async () => {
    const { buildSources, NPMMIRROR_BASE, GITHUB_BASE } = await import('../../src/core/python-provision.js');
    const s = buildSources({});
    assert.equal(s.length, 2);
    assert.equal(s[0]!.kind, 'listing');
    assert.equal(s[0]!.base, NPMMIRROR_BASE);
    assert.equal(s[1]!.kind, 'pinned');
    assert.equal(s[1]!.base, GITHUB_BASE);
  });

  it('MOLIO_PYTHON_MIRROR replaces the npmmirror slot (trailing slashes stripped)', async () => {
    const { buildSources, GITHUB_BASE } = await import('../../src/core/python-provision.js');
    const s = buildSources({ MOLIO_PYTHON_MIRROR: 'https://my.mirror.internal/pbs///' });
    assert.equal(s.length, 2);
    assert.equal(s[0]!.base, 'https://my.mirror.internal/pbs');
    assert.equal(s[0]!.kind, 'listing', 'custom mirror uses the same JSON-listing layout as npmmirror');
    assert.equal(s[1]!.base, GITHUB_BASE, 'GitHub pinned must always remain the last resort');
  });

  it('blank/whitespace env is treated as unset', async () => {
    const { buildSources, NPMMIRROR_BASE } = await import('../../src/core/python-provision.js');
    const s = buildSources({ MOLIO_PYTHON_MIRROR: '   ' });
    assert.equal(s[0]!.base, NPMMIRROR_BASE);
  });
});

// ─── provision 集成（全 seam 注入，零真实网络） ─────────────────────────────

/** 构造一套可编程 deps + 记录器。 */
async function mkHarness() {
  const mod = await import('../../src/core/python-provision.js');
  const triple = mod.platformTriple();
  const archive = Buffer.from('fake-pbs-archive-bytes-for-test');
  const sha = crypto.createHash('sha256').update(archive).digest('hex');
  const fetchUrls: string[] = [];
  const downloadUrls: string[] = [];
  const extractCalls: Array<{ archive: string; staging: string }> = [];
  const progress: Array<{ pct: number; msg: string }> = [];
  return { mod, triple, archive, sha, fetchUrls, downloadUrls, extractCalls, progress };
}

/** 标准 listing 源 fixture：tag 列表 + tag 目录 + SHA256SUMS。 */
function listingFixture(opts: {
  base: string;
  tag: string;
  filename: string;
  sumsText: string | null; // null = sums 请求抛错
  extraTagNames?: string[];
}) {
  const dirNames = [
    'SHA256SUMS',
    opts.filename,
    opts.filename.replace('3.12.14', '3.12.13'), // 低 patch 干扰项
    opts.filename.replace('3.12.14', '3.13.1'), // 错误 minor 干扰项（regex 锁 3\.12）
    'README.md',
  ];
  return (url: string): string | null | undefined => {
    if (url === `${opts.base}/`) {
      return JSON.stringify([
        ...(opts.extraTagNames ?? []).map((n) => ({ name: n })),
        { name: `${opts.tag}/`, size: 0 },
      ]);
    }
    if (url === `${opts.base}/${opts.tag}/`) {
      return JSON.stringify(dirNames.map((n) => ({ name: n, size: 1 })));
    }
    if (url === `${opts.base}/${opts.tag}/SHA256SUMS`) {
      return opts.sumsText; // null → caller throws
    }
    return undefined; // 不认识的 URL
  };
}

describe('provisionManagedPython (seam 注入集成)', () => {
  it('已装短路：isInstalled 命中 → 零网络调用', async () => {
    const { mod } = await mkHarness();
    let fetchCalled = 0;
    let downloadCalled = 0;
    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      deps: {
        isInstalled: () => '/already/here/python3',
        fetchText: async () => { fetchCalled++; return '[]'; },
        download: async () => { downloadCalled++; return Buffer.alloc(0); },
      },
    });
    assert.equal(out, '/already/here/python3');
    assert.equal(fetchCalled, 0, 'short-circuit must not touch the network');
    assert.equal(downloadCalled, 0);
  });

  it('成功路径：npmmirror 发现→下载→sha 校验→解压→验证→原子换位', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({
      base: mod.NPMMIRROR_BASE,
      tag,
      filename,
      sumsText: `${sha}  ${filename}\n`,
    });

    // 旧 root 存在（损坏残留）→ 成功后必须被换掉
    const oldRoot = mod.managedPythonRoot();
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'junk.txt'), 'broken');

    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      onProgress: (pct, msg) => h.progress.push({ pct, msg }),
      deps: {
        isInstalled: () => null,
        fetchText: async (url) => {
          h.fetchUrls.push(url);
          const r = route(url);
          if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
          return r;
        },
        download: async (url, _sig, onBytes) => {
          h.downloadUrls.push(url);
          onBytes?.(archive.length, archive.length);
          return archive;
        },
        extract: async (a, staging) => {
          h.extractCalls.push({ archive: a, staging });
          const exe = path.join(staging, exeRel());
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, 'fake-exe');
        },
        runInterpreter: async () => 'Python 3.12.14',
      },
    });

    // URL 序列：tag 列表 → tag 目录 → SHA256SUMS → archive 下载
    assert.deepEqual(h.fetchUrls, [
      `${mod.NPMMIRROR_BASE}/`,
      `${mod.NPMMIRROR_BASE}/${tag}/`,
      `${mod.NPMMIRROR_BASE}/${tag}/SHA256SUMS`,
    ]);
    assert.deepEqual(h.downloadUrls, [`${mod.NPMMIRROR_BASE}/${tag}/${filename}`]);
    // 返回值 + 换位结果
    assert.equal(out, mod.managedPythonExe());
    assert.equal(fs.existsSync(out), true, 'staging exe must land at the final root');
    assert.equal(fs.existsSync(path.join(oldRoot, 'junk.txt')), false, 'old broken root must be replaced');
    // extract 收到真实存在的临时 archive 路径 + ~/.molio 下的 staging
    assert.equal(h.extractCalls.length, 1);
    assert.ok(h.extractCalls[0]!.staging.startsWith(path.join(tmpHome, '.molio', 'python.staging-')));
    assert.equal(fs.existsSync(h.extractCalls[0]!.archive), false, 'temp archive cleaned in finally');
    // staging 无残留
    const leftovers = fs.readdirSync(path.join(tmpHome, '.molio')).filter((n) => n.startsWith('python.staging-'));
    assert.deepEqual(leftovers, [], 'staging must be renamed away, no leftovers');
    // 进度带宽 3-10 + 就绪消息
    assert.ok(h.progress.every((p) => p.pct >= 3 && p.pct <= 10), `pct must stay in 3-10, got ${JSON.stringify(h.progress.map((p) => p.pct))}`);
    assert.ok(h.progress.some((p) => p.msg.includes('独立 Python 运行环境就绪')));
  });

  it('sha256 不匹配 → 弃用该源，GitHub pinned 兜底成功', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const pinnedFilename = `cpython-${mod.FALLBACK_PY_VERSION}+${mod.FALLBACK_TAG}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({
      base: mod.NPMMIRROR_BASE,
      tag,
      filename,
      sumsText: `${'f'.repeat(64)}  ${filename}\n`, // 错误哈希（镜像投毒/损坏）
    });

    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      onProgress: (pct, msg) => h.progress.push({ pct, msg }),
      deps: {
        isInstalled: () => null,
        fetchText: async (url) => {
          h.fetchUrls.push(url);
          if (url === `${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/SHA256SUMS`) {
            return `${sha}  ${pinnedFilename}\n`;
          }
          const r = route(url);
          if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
          return r;
        },
        download: async (url, _sig, onBytes) => {
          h.downloadUrls.push(url);
          onBytes?.(archive.length, archive.length);
          return archive;
        },
        extract: async (_a, staging) => {
          const exe = path.join(staging, exeRel());
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, 'fake-exe');
        },
        runInterpreter: async () => 'Python 3.12.14',
      },
    });

    assert.equal(out, mod.managedPythonExe());
    assert.equal(h.downloadUrls.length, 2, 'bad-hash archive downloaded once, then the fallback source');
    assert.equal(h.downloadUrls[1], `${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/${pinnedFilename}`);
    assert.ok(
      h.progress.some((p) => p.msg.includes('SHA256 校验失败') && p.msg.includes('换下一个源')),
      'user must see why the source was abandoned',
    );
  });

  it('npmmirror 全挂（listing 不可达）→ GitHub pinned tag 直拼成功', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const pinnedFilename = `cpython-${mod.FALLBACK_PY_VERSION}+${mod.FALLBACK_TAG}-${triple}-install_only_stripped.tar.gz`;

    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      deps: {
        isInstalled: () => null,
        fetchText: async (url) => {
          h.fetchUrls.push(url);
          if (url.startsWith(mod.NPMMIRROR_BASE)) throw new Error('ECONNRESET');
          if (url === `${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/SHA256SUMS`) {
            return `${sha}  ${pinnedFilename}\n`;
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
        download: async (url, _sig, onBytes) => {
          h.downloadUrls.push(url);
          onBytes?.(archive.length, archive.length);
          return archive;
        },
        extract: async (_a, staging) => {
          const exe = path.join(staging, exeRel());
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, 'fake-exe');
        },
        runInterpreter: async () => `Python ${mod.FALLBACK_PY_VERSION}`,
      },
    });

    assert.equal(out, mod.managedPythonExe());
    assert.deepEqual(h.downloadUrls, [`${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/${pinnedFilename}`]);
    assert.ok(h.downloadUrls[0]!.includes(mod.FALLBACK_PY_VERSION), 'pinned filename carries the pinned version');
  });

  it('MOLIO_PYTHON_MIRROR env 优先于 npmmirror（内网自建镜像）', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    process.env['MOLIO_PYTHON_MIRROR'] = 'https://mirror.corp.internal/pbs';
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({ base: 'https://mirror.corp.internal/pbs', tag, filename, sumsText: `${sha}  ${filename}\n` });

    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      deps: {
        isInstalled: () => null,
        fetchText: async (url) => {
          h.fetchUrls.push(url);
          const r = route(url);
          if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
          return r;
        },
        download: async (url, _sig, onBytes) => {
          h.downloadUrls.push(url);
          onBytes?.(archive.length, archive.length);
          return archive;
        },
        extract: async (_a, staging) => {
          const exe = path.join(staging, exeRel());
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, 'fake-exe');
        },
        runInterpreter: async () => 'Python 3.12.14',
      },
    });

    assert.equal(out, mod.managedPythonExe());
    assert.equal(h.fetchUrls[0], 'https://mirror.corp.internal/pbs/', 'custom mirror must be queried first');
    assert.equal(h.downloadUrls.length, 1);
    assert.ok(h.downloadUrls[0]!.startsWith('https://mirror.corp.internal/pbs/'));
  });

  it('SHA256SUMS 取不到 → 记警告继续（自建镜像未同步 sums 不阻断）', async () => {
    const h = await mkHarness();
    const { mod, triple, archive } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({ base: mod.NPMMIRROR_BASE, tag, filename, sumsText: null });

    const out = await mod.provisionManagedPython({
      signal: new AbortController().signal,
      onProgress: (pct, msg) => h.progress.push({ pct, msg }),
      deps: {
        isInstalled: () => null,
        fetchText: async (url) => {
          const r = route(url);
          if (r === null) throw new Error(`HTTP 404 @ ${url}`);
          if (r === undefined) throw new Error(`unexpected fetch: ${url}`);
          return r;
        },
        download: async (url, _sig, onBytes) => {
          h.downloadUrls.push(url);
          onBytes?.(archive.length, archive.length);
          return archive;
        },
        extract: async (_a, staging) => {
          const exe = path.join(staging, exeRel());
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, 'fake-exe');
        },
        runInterpreter: async () => 'Python 3.12.14',
      },
    });

    assert.equal(out, mod.managedPythonExe());
    assert.equal(h.downloadUrls.length, 1, 'missing sums must NOT skip the source');
    assert.ok(h.progress.some((p) => p.msg.includes('跳过完整性校验')));
  });

  it('abort 中断（extract 阶段）→ 传播 abort、staging/临时文件清理、旧 root 完好', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({ base: mod.NPMMIRROR_BASE, tag, filename, sumsText: `${sha}  ${filename}\n` });

    // 旧 root（哪怕损坏）在 abort 时绝不能被动过
    const oldRoot = mod.managedPythonRoot();
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'keep.txt'), 'old');

    const ac = new AbortController();
    let tmpArchivePath: string | null = null;
    await assert.rejects(
      mod.provisionManagedPython({
        signal: ac.signal,
        deps: {
          isInstalled: () => null,
          fetchText: async (url) => {
            const r = route(url);
            if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
            return r;
          },
          download: async (url) => {
            h.downloadUrls.push(url);
            return archive;
          },
          extract: async (a) => {
            tmpArchivePath = a;
            ac.abort(); // 模拟用户在解压中点了停止
            throw new Error('aborted');
          },
          runInterpreter: async () => 'Python 3.12.14',
        },
      }),
      /aborted/,
    );

    assert.equal(h.downloadUrls.length, 1, 'abort must not fall through to the next source');
    const leftovers = fs.existsSync(path.join(tmpHome, '.molio'))
      ? fs.readdirSync(path.join(tmpHome, '.molio')).filter((n) => n.startsWith('python.staging-'))
      : [];
    assert.deepEqual(leftovers, [], 'staging must be cleaned on abort');
    assert.ok(tmpArchivePath && !fs.existsSync(tmpArchivePath), 'temp archive must be cleaned on abort');
    assert.equal(fs.existsSync(path.join(oldRoot, 'keep.txt')), true, 'existing root must survive an abort');
  });

  it('extract 失败（tar 退出码≠0）→ 全源失败抛带 hint 错误、staging 清理、旧 root 完好', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const pinnedFilename = `cpython-${mod.FALLBACK_PY_VERSION}+${mod.FALLBACK_TAG}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({ base: mod.NPMMIRROR_BASE, tag, filename, sumsText: `${sha}  ${filename}\n` });

    const oldRoot = mod.managedPythonRoot();
    fs.mkdirSync(oldRoot, { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'keep.txt'), 'old');

    await assert.rejects(
      mod.provisionManagedPython({
        signal: new AbortController().signal,
        onProgress: (pct, msg) => h.progress.push({ pct, msg }),
        deps: {
          isInstalled: () => null,
          fetchText: async (url) => {
            if (url === `${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/SHA256SUMS`) {
              return `${sha}  ${pinnedFilename}\n`;
            }
            const r = route(url);
            if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
            return r;
          },
          download: async (url) => {
            h.downloadUrls.push(url);
            return archive;
          },
          extract: async () => {
            throw new mod.PythonProvisionError('tar 解压失败（退出码 1）：unexpected eof');
          },
          runInterpreter: async () => 'Python 3.12.14',
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof mod.PythonProvisionError);
        const m = (err as Error).message;
        assert.match(m, /自动下载独立 Python 失败/);
        assert.match(m, /MOLIO_PYTHON_MIRROR/, 'error must hint the custom-mirror escape hatch');
        assert.match(m, /手动安装 Python/, 'error must hint manual installation');
        return true;
      },
    );

    assert.equal(h.downloadUrls.length, 2, 'both sources must be attempted before giving up');
    const leftovers = fs.readdirSync(path.join(tmpHome, '.molio')).filter((n) => n.startsWith('python.staging-'));
    assert.deepEqual(leftovers, [], 'failed staging dirs must be cleaned');
    assert.equal(fs.existsSync(path.join(oldRoot, 'keep.txt')), true, 'failed provision must not touch an existing root');
  });

  it('解释器验证失败（版本不符/跑不起来）→ 换源后全失败', async () => {
    const h = await mkHarness();
    const { mod, triple, archive, sha } = h;
    const tag = '20260924';
    const filename = `cpython-3.12.14+${tag}-${triple}-install_only_stripped.tar.gz`;
    const pinnedFilename = `cpython-${mod.FALLBACK_PY_VERSION}+${mod.FALLBACK_TAG}-${triple}-install_only_stripped.tar.gz`;
    const route = listingFixture({ base: mod.NPMMIRROR_BASE, tag, filename, sumsText: `${sha}  ${filename}\n` });

    await assert.rejects(
      mod.provisionManagedPython({
        signal: new AbortController().signal,
        deps: {
          isInstalled: () => null,
          fetchText: async (url) => {
            if (url === `${mod.GITHUB_BASE}/${mod.FALLBACK_TAG}/SHA256SUMS`) {
              return `${sha}  ${pinnedFilename}\n`;
            }
            const r = route(url);
            if (r === undefined || r === null) throw new Error(`unexpected fetch: ${url}`);
            return r;
          },
          download: async () => archive,
          extract: async (_a, staging) => {
            const exe = path.join(staging, exeRel());
            fs.mkdirSync(path.dirname(exe), { recursive: true });
            fs.writeFileSync(exe, 'fake-exe');
          },
          runInterpreter: async () => null, // musl/老 Windows：解压出来也跑不动
        },
      }),
      /自动下载独立 Python 失败/,
    );
    assert.equal(fs.existsSync(mod.managedPythonRoot()), false, 'a broken interpreter must never be swapped into root');
  });
});

// ─── systemTarExtract（Windows 盘符真机回归） ───────────────────────────────
//
// Error-driven (2026-09-29 真机验收): GNU tar/bsdtar 的 `-f` 把 `C:\...tar.gz`
// 当 `host:path` 远程语法 → "Cannot connect to C: resolve failed" + unexpected
// eof，供给全源失败。修法 = cwd 切到 archive 目录、只传裸文件名。seam 注入的
// 单测碰不到真实 tar，故这里跑一次真解压钉住它。

describe('systemTarExtract (Windows 盘符 host:path 回归)', () => {
  it('extracts a real tar.gz whose path contains a drive letter / colon', async () => {
    const { systemTarExtract } = await import('../../src/core/python-provision.js');
    const { execFileSync } = await import('node:child_process');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-tar-reg-'));
    try {
      // 造一个含 symlink 的真 tar.gz，布局对齐 PBS（顶层 python/ 目录，
      // 故 --strip-components=1 后是 bin/python3）
      const srcDir = path.join(work, 'srcroot');
      fs.mkdirSync(path.join(srcDir, 'python', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'python', 'bin', 'python3'), 'real');
      if (!isWindows) fs.symlinkSync('python3', path.join(srcDir, 'python', 'bin', 'python'));
      const archive = path.join(work, 'pkg.tar.gz'); // Windows: C:\... 含盘符冒号
      // 创建时同样避开 host:path —— cwd + 裸名（这正是被测代码用的策略）
      execFileSync('tar', ['-czf', 'pkg.tar.gz', '-C', 'srcroot', 'python'], { cwd: work });
      assert.ok(archive.includes(':') || !isWindows, 'test only meaningful when the path has a colon (win) or always (posix)');

      const staging = path.join(work, 'staging');
      fs.mkdirSync(staging, { recursive: true });
      await systemTarExtract(archive, staging);
      assert.equal(
        fs.readFileSync(path.join(staging, 'bin', 'python3'), 'utf-8'),
        'real',
        'extraction must succeed despite the drive-letter path',
      );
      if (!isWindows) {
        assert.equal(
          fs.lstatSync(path.join(staging, 'bin', 'python')).isSymbolicLink(),
          true,
          'symlinks must survive (system tar, not in-memory)',
        );
      }
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── resolveManagedPython（runner 注入） ────────────────────────────────────

describe('resolveManagedPython (--version 试运行，stat 不够)', () => {
  it('exe 不存在 → null（runner 不被调用）', async () => {
    const { resolveManagedPython } = await import('../../src/core/python-provision.js');
    let called = 0;
    const out = resolveManagedPython(() => { called++; return 'Python 3.12.14'; });
    assert.equal(out, null);
    assert.equal(called, 0);
  });

  it('exe 存在且 --version 达标 → 返回路径', async () => {
    const { resolveManagedPython, managedPythonExe } = await import('../../src/core/python-provision.js');
    const exe = managedPythonExe();
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'fake');
    assert.equal(resolveManagedPython(() => 'Python 3.12.14'), exe);
    assert.equal(resolveManagedPython(() => 'Python 3.10.0'), exe, '3.10 is the floor');
  });

  it('exe 存在但跑不起来/版本过旧 → null（解压损坏防御）', async () => {
    const { resolveManagedPython, managedPythonExe } = await import('../../src/core/python-provision.js');
    const exe = managedPythonExe();
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'junk');
    assert.equal(resolveManagedPython(() => null), null);
    assert.equal(resolveManagedPython(() => 'Python 3.9.7'), null, 'below the 3.10 floor');
    assert.equal(resolveManagedPython(() => 'total garbage'), null);
  });
});
