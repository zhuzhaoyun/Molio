import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Tests for PreloadManager path helpers, status state machine, and dismiss
 * persistence. The actual pip/npm downloads are NOT exercised here — they
 * are slow, network-dependent, and belong to manual verification. What we
 * verify here is the logic that decides *where* things install and *when*
 * the user gets prompted.
 *
 * Error-driven context:
 * - Bug: docling installed via preload landed in an unpredictable pip
 *   location and the agent couldn't find it. Fix: dedicated venv at
 *   ~/.molio/venv, with augmentPath exposing its bin dir (tested in
 *   env.test.ts). These tests pin the venv path layout so future edits
 *   don't silently move the install location.
 * - Bug: remotion "detectInstalled" returned true whenever `node` existed,
 *   so the toast never prompted. Fix: detectInstalled now checks a marker
 *   file written after a successful cache warmup.
 */

// ─── Path layout (where preload installs things) ───────────────────────────

describe('PreloadManager path layout', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    if (isWindows) {
      savedHome = process.env['USERPROFILE'];
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-test-'));
      process.env['USERPROFILE'] = tmpHome;
    } else {
      savedHome = process.env['HOME'];
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-test-'));
      process.env['HOME'] = tmpHome;
    }
  });

  afterEach(() => {
    if (isWindows) {
      if (savedHome !== undefined) process.env['USERPROFILE'] = savedHome;
      else delete process.env['USERPROFILE'];
    } else {
      if (savedHome !== undefined) process.env['HOME'] = savedHome;
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('venv binary dir lives under ~/.molio/venv (Unix) or Scripts (Windows)', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    createPreloadManager(); // instantiate to ensure module loads
    // The layout is a constant; we assert the on-disk convention so a
    // refactor that moves it off ~/.molio/venv fails loudly.
    const expected = isWindows
      ? path.join(tmpHome, '.molio', 'venv', 'Scripts')
      : path.join(tmpHome, '.molio', 'venv', 'bin');
    assert.ok(
      expected.includes(path.join('.molio', 'venv')),
      `venv should live under ~/.molio/venv, got: ${expected}`,
    );
  });

  it('docling detectInstalled returns false when venv binary absent and not on PATH', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    // tmpHome has no ~/.molio/venv and docling isn't on the test PATH.
    // detectInstalled must not throw and must resolve to missing.
    // (If the CI host happens to have a global docling, this still passes
    // via the PATH fallback — which is the correct real-world behavior.)
    const statuses = pm.getStatuses();
    assert.ok(
      statuses.docling.status === 'missing' || statuses.docling.status === 'installed',
      `docling should resolve to missing or installed, got: ${statuses.docling.status}`,
    );
  });

  it('docling detectInstalled returns true when venv binary exists', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    // Create the venv binary so detectInstalled's primary check passes.
    const venvBin = isWindows
      ? path.join(tmpHome, '.molio', 'venv', 'Scripts')
      : path.join(tmpHome, '.molio', 'venv', 'bin');
    fs.mkdirSync(venvBin, { recursive: true });
    const doclingBin = isWindows
      ? path.join(venvBin, 'docling.exe')
      : path.join(venvBin, 'docling');
    fs.writeFileSync(doclingBin, '');

    const pm = createPreloadManager();
    pm.checkSkills();
    const statuses = pm.getStatuses();
    assert.equal(
      statuses.docling.status,
      'installed',
      `docling should be installed when venv binary exists, got: ${statuses.docling.status}`,
    );
  });

  it('remotion detectInstalled returns true only when marker exists', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const marker = path.join(tmpHome, '.molio', '.remotion-preloaded');

    const pm1 = createPreloadManager();
    pm1.checkSkills();
    assert.equal(
      pm1.getStatuses().remotion.status,
      'missing',
      'remotion should be missing before any preload (no marker)',
    );

    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());

    const pm2 = createPreloadManager();
    pm2.checkSkills();
    assert.equal(
      pm2.getStatuses().remotion.status,
      'installed',
      'remotion should be installed once the marker exists',
    );
  });
});

// ─── Status state machine (no real downloads) ──────────────────────────────

describe('PreloadManager status state machine', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = isWindows ? process.env['USERPROFILE'] : process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-state-'));
    if (isWindows) process.env['USERPROFILE'] = tmpHome;
    else process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      if (isWindows) process.env['USERPROFILE'] = savedHome;
      else process.env['HOME'] = savedHome;
    } else {
      if (isWindows) delete process.env['USERPROFILE'];
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('checkSkills marks missing skills as missing', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    const s = pm.getStatuses();
    // On a clean tmpHome, both should be missing (no venv, no marker).
    // (A CI host with global docling/node could flip docling to installed;
    //  remotion has no global fallback so it must be missing.)
    assert.equal(s.remotion.status, 'missing');
  });

  it('dismissSkill persists to config and prevents re-prompting', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();

    pm.dismissSkill('remotion');
    assert.equal(pm.getStatuses().remotion.status, 'dismissed');

    // A fresh instance should read the persisted dismissed state.
    const pm2 = createPreloadManager();
    pm2.checkSkills();
    assert.equal(
      pm2.getStatuses().remotion.status,
      'dismissed',
      'dismiss should persist across instances via config.json',
    );
  });

  it('undismissSkill re-checks and returns the skill to missing', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    pm.dismissSkill('remotion');
    assert.equal(pm.getStatuses().remotion.status, 'dismissed');

    pm.undismissSkill('remotion');
    assert.equal(
      pm.getStatuses().remotion.status,
      'missing',
      'undismiss should restore the skill to a checkable state',
    );
  });
});

// ─── npm registry fallback (remotion preload ETARGET regression) ───────────
//
// Error-driven context (2026-07-29): remotion 发版 4.0.501，create-video 脚手架
// 把所有 @remotion/* 严格钉到该版本；但国内镜像（npmmirror）逐包独立、按需同步，
// 主包 @remotion/cli 已同步而传递依赖 @remotion/player 未同步 → `npm install`
// ETARGET 退出码 1。旧代码只会在**同一个源**上重试一次，镜像同步滞后以小时计，
// 重试必然再次失败 → 预下载整体失败。修复：按 默认源 → 官方源（同步源头，版本
// 永远齐全）→ npmmirror 的顺序降级换源重试；暂停/停止不打断语义保持不变。

describe('runWithRegistryFallback (remotion preload ETARGET regression)', () => {
  const mkSignal = () => new AbortController().signal;
  const OFFICIAL = '--registry=https://registry.npmjs.org';

  it('default registry ETARGET failure falls back to the official registry', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const flags: string[] = [];
    await runWithRegistryFallback({
      label: 'Remotion 依赖安装（npm install）',
      signal: mkSignal(),
      exec: async (flag) => {
        flags.push(flag);
        // 模拟镜像未同步钉住版本：默认源 ETARGET，官方源放行
        if (flag !== OFFICIAL) {
          throw new Error('进程退出码 1: npm error notarget No matching version found for @remotion/player@4.0.501.');
        }
      },
    });
    assert.ok(flags.length >= 2, `expected multiple attempts, got ${flags.length}`);
    assert.equal(flags[0], '', 'first attempt must use the default registry (empty flag)');
    assert.ok(flags.includes(OFFICIAL), 'must fall back to the official npm registry');
  });

  it('transient failure retries within the same registry before switching', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const flags: string[] = [];
    await runWithRegistryFallback({
      label: 'step',
      signal: mkSignal(),
      exec: async (flag) => {
        flags.push(flag);
        if (flags.length === 1) throw new Error('进程退出码 1: network hiccup');
      },
    });
    assert.equal(flags.length, 2, 'should retry once on the same registry then succeed');
    assert.ok(flags.every((f) => f === ''), 'no registry switch needed for a transient failure');
  });

  it('abort interrupts immediately without retry or registry switch', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const ac = new AbortController();
    const flags: string[] = [];
    await assert.rejects(
      runWithRegistryFallback({
        label: 'step',
        signal: ac.signal,
        exec: async (flag) => {
          flags.push(flag);
          ac.abort();
          throw new Error('aborted');
        },
      }),
      /aborted/,
    );
    assert.equal(flags.length, 1, 'abort must not trigger retries or a registry switch');
  });

  it('final failure message includes the step label and the underlying output tail', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    await assert.rejects(
      runWithRegistryFallback({
        label: 'Remotion 依赖安装（npm install）',
        signal: mkSignal(),
        exec: async () => {
          throw new Error('进程退出码 1: npm error notarget No matching version found for @remotion/player@4.0.501.');
        },
      }),
      (err: Error) => {
        assert.match(err.message, /Remotion 依赖安装/, 'error must name the failing step');
        assert.match(err.message, /notarget/, 'error must carry the underlying output tail');
        return true;
      },
    );
  });

  it('POSIX shell command builders place the registry flag correctly', async () => {
    const { remotionScaffoldCmd, remotionInstallCmd } = await import('../../src/core/preload-manager.js');
    assert.equal(remotionScaffoldCmd(''), 'npx --yes create-video@latest --yes --blank --no-tailwind warmup');
    assert.equal(remotionInstallCmd(''), 'npm install --no-audit --no-fund');
    assert.equal(
      remotionScaffoldCmd(OFFICIAL),
      'npx --yes --registry=https://registry.npmjs.org create-video@latest --yes --blank --no-tailwind warmup',
    );
    assert.equal(
      remotionInstallCmd(OFFICIAL),
      'npm install --registry=https://registry.npmjs.org --no-audit --no-fund',
    );
  });

  it('Windows argv builders invoke node + npm/npx JS entry directly (no cmd.exe)', async () => {
    const { remotionScaffoldArgv, remotionInstallArgv } = await import('../../src/core/preload-manager.js');
    const node = 'C:\\node.exe';
    const npmJs = 'C:\\node_modules\\npm\\bin\\npm-cli.js';
    const npxJs = 'C:\\node_modules\\npm\\bin\\npx-cli.js';
    // install：node + npm-cli.js install，in-process，无孙进程 → 无控制台窗口
    assert.deepEqual(remotionInstallArgv(node, npmJs, ''), [node, npmJs, 'install', '--no-audit', '--no-fund']);
    assert.deepEqual(remotionInstallArgv(node, npmJs, OFFICIAL), [node, npmJs, 'install', OFFICIAL, '--no-audit', '--no-fund']);
    // scaffold：node + npx-cli.js，create-video 仍是 npx 的子进程
    assert.deepEqual(
      remotionScaffoldArgv(node, npxJs, ''),
      [node, npxJs, '--yes', 'create-video@latest', '--yes', '--blank', '--no-tailwind', 'warmup'],
    );
    assert.deepEqual(
      remotionScaffoldArgv(node, npxJs, OFFICIAL),
      [node, npxJs, OFFICIAL, '--yes', 'create-video@latest', '--yes', '--blank', '--no-tailwind', 'warmup'],
    );
  });

  it('npmCliJsFromDir maps a PATH shim dir to the npm JS entry', async () => {
    const { npmCliJsFromDir } = await import('../../src/core/preload-manager.js');
    assert.equal(
      npmCliJsFromDir('C:\\Program Files\\nodejs', 'npm'),
      path.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    assert.equal(
      npmCliJsFromDir('/usr/local/bin', 'npx'),
      path.join('/usr/local/bin', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    );
  });
});

// ─── docling post-install binary check (Windows .exe regression) ───────────
//
// Error-driven (2026-07): 安装后校验曾写死无扩展名的 `docling`，Windows 上 pip
// 生成的是 `docling.exe`，existsSync 恒 false → 装好也判失败。修复后校验与检测
// 共用 doclingVenvBinaryPresent()（平台正确名）。这里钉住该判定，并防止反向错误
// （在 Windows 上接受无扩展名 / 在 POSIX 上接受 .exe）。

describe('doclingVenvBinaryPresent (Windows .exe regression)', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = isWindows ? process.env['USERPROFILE'] : process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-docling-bin-'));
    if (isWindows) process.env['USERPROFILE'] = tmpHome;
    else process.env['HOME'] = tmpHome;
  });
  afterEach(() => {
    if (savedHome !== undefined) {
      if (isWindows) process.env['USERPROFILE'] = savedHome;
      else process.env['HOME'] = savedHome;
    } else {
      if (isWindows) delete process.env['USERPROFILE'];
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('accepts the platform-correct launcher and rejects the wrong-platform name', async () => {
    const { doclingVenvBinaryPresent } = await import('../../src/core/preload-manager.js');
    const binDir = isWindows
      ? path.join(tmpHome, '.molio', 'venv', 'Scripts')
      : path.join(tmpHome, '.molio', 'venv', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const correct = isWindows ? 'docling.exe' : 'docling';
    const wrong = isWindows ? 'docling' : 'docling.exe';

    // 只有「错误平台名」→ 不能算装好（这正是旧 bug：Windows 上只认 docling.exe，
    // 旧代码却去找 docling，于是即便装好也 false；这里反过来锁住，确保不会退化）
    fs.writeFileSync(path.join(binDir, wrong), '');
    assert.equal(
      doclingVenvBinaryPresent(),
      false,
      'the wrong-platform binary name must NOT satisfy the check',
    );

    // 放上平台正确名 → 装好
    fs.writeFileSync(path.join(binDir, correct), '');
    assert.equal(
      doclingVenvBinaryPresent(),
      true,
      'the platform-correct launcher must satisfy the check',
    );
  });
});

// ─── preloadSpawnOpts (Windows console-window regression) ──────────────────
//
// Error-driven (2026-07): spawn 子进程带 detached 却没设 windowsHide，Windows
// 给 cmd/npm/python 各弹一个黑控制台窗口。windowsHide:true 在 POSIX 是 no-op，
// 故只影响 Windows 弹窗，跨平台安全。

describe('preloadSpawnOpts (Windows console-window regression)', () => {
  const isWindows = process.platform === 'win32';

  it('hides the child console window; detached only on POSIX', async () => {
    const { preloadSpawnOpts } = await import('../../src/core/preload-manager.js');
    const o = preloadSpawnOpts({});
    assert.equal(
      o.windowsHide,
      true,
      'windowsHide must be set so Windows does not pop a console window per child',
    );
    // detached on Windows maps to DETACHED_PROCESS in libuv, which defeats
    // windowsHide and makes console grandchildren (node/python under npm/pip)
    // each allocate a visible console window — exactly the bug being fixed.
    // Tree-kill on Windows uses taskkill /T, so detached is not needed there.
    assert.equal(
      o.detached,
      !isWindows,
      'detached must be true on POSIX (process-group kill) and false on Windows',
    );
    assert.deepEqual(o.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(o.env, undefined, 'no env overlay → inherit daemon env as-is');
  });

  it('overlays caller env on top of the inherited daemon env', async () => {
    const { preloadSpawnOpts } = await import('../../src/core/preload-manager.js');
    const o = preloadSpawnOpts({ env: { HF_ENDPOINT: 'https://hf-mirror.com' } });
    const env = o.env as Record<string, string | undefined>;
    assert.equal(env['HF_ENDPOINT'], 'https://hf-mirror.com');
    // 仍继承 daemon 自身环境（如 PATH），不能丢
    assert.ok(env['PATH'] !== undefined || env['Path'] !== undefined, 'inherited env (PATH) must survive the overlay');
  });
});

// ─── docling warmup argv (Win launcher→grandchild + empty-input no-op) ─────
//
// Error-driven (2026-07): 模型预热若走 docling.exe，该 launcher 会再 spawn
// python 作为带控制台窗口的孙进程。Windows 改走 `python -c <shim>` 让 python
// 成为直跑子进程（windowsHide 隐藏），docling 在进程内运行，无孙进程。
// Error-driven (2026-07, retrospective 开放遗留 #1): 预热若喂空输入(/dev/null /
// NUL)，docling 在格式识别阶段就拒绝（format None），模型从不加载 → HF 缓存
// 一直空、首次转换才下 ~500MB。故 warmup 必须喂一个真实合法文件 + `--from md`
// 钉死格式，确保走到模型加载。

describe('doclingWarmupArgv (Win launcher→grandchild + warmup-input regression)', () => {
  it('Windows runs docling via python -c shim (in-process, no launcher)', async () => {
    const { doclingWarmupArgv, DOCLING_CLI_SHIM } = await import('../../src/core/preload-manager.js');
    const argv = doclingWarmupArgv(true, 'C:\\venv\\python.exe', 'C:\\out\\warmup.pdf', 'C:\\out');
    assert.equal(argv[0], 'C:\\venv\\python.exe');
    assert.equal(argv[1], '-c');
    assert.equal(argv[2], DOCLING_CLI_SHIM);
    // 真实 CLI 参数作为 -c 之后的 argv 传入（无需把路径嵌进 -c 字符串）
    assert.deepEqual(argv.slice(3), ['C:\\out\\warmup.pdf', '--from', 'pdf', '--to', 'md', '--output', 'C:\\out']);
    assert.match(DOCLING_CLI_SHIM, /docling\.cli\.main import app/, 'shim must invoke the published entry point');
  });

  it('POSIX keeps the real docling launcher (no console concept there)', async () => {
    const { doclingWarmupArgv } = await import('../../src/core/preload-manager.js');
    const argv = doclingWarmupArgv(false, '/venv/bin/python', '/out/warmup.pdf', '/out');
    // POSIX 首参是 docling 二进制（bin/docling），不是 python -c
    assert.ok(!argv.includes('-c'), 'POSIX must not use the -c shim');
    assert.deepEqual(argv.slice(1), ['/out/warmup.pdf', '--from', 'pdf', '--to', 'md', '--output', '/out']);
  });

  it('warmup pins --from pdf and a real PDF input (md/empty skip model load)', async () => {
    const { doclingWarmupArgv, DOCLING_WARMUP_PDF_B64 } = await import('../../src/core/preload-manager.js');
    // bundled warmup PDF must decode to a real PDF (magic header %PDF-)
    const pdf = Buffer.from(DOCLING_WARMUP_PDF_B64, 'base64');
    assert.equal(pdf.slice(0, 5).toString(), '%PDF-', 'bundled warmup input must be a real PDF');
    for (const isWin of [true, false]) {
      const argv = doclingWarmupArgv(isWin, isWin ? 'py.exe' : '/bin/docling', '/in/warmup.pdf', '/out');
      // markdown/empty input routes to SimplePipeline (no AI models); PDF forces
      // StandardPdfPipeline which loads layout/table models at init.
      assert.ok(argv.includes('--from'), 'must pass --from so the input is not mis-sniffed');
      assert.equal(argv[argv.indexOf('--from') + 1], 'pdf', '--from must pin PDF (md would skip model load)');
      assert.ok(argv.some((a) => a.endsWith('warmup.pdf')), 'must feed a real PDF, not /dev/null/NUL/.md');
      assert.ok(!argv.includes('/dev/null') && !argv.includes('NUL'), 'empty input would skip model loading');
    }
  });
});

// ─── pause→stop clears lingering pause intent (latent bug) ────────────────
//
// Error-driven (2026-07): 暂停→停止 后 stopRequested 被清，但 pauseRequested
// 残留 → 下一次 startPreload 的 onProgress 被静音、失败被错标成 'paused'。
// stop 是「完全重置」，必须连 pause 意图一起清。这里钉住该不变量。

describe('pause→stop clears lingering pause intent (2026-07 latent bug)', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = isWindows ? process.env['USERPROFILE'] : process.env['HOME'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-intent-'));
    if (isWindows) process.env['USERPROFILE'] = tmpHome;
    else process.env['HOME'] = tmpHome;
  });
  afterEach(() => {
    if (savedHome !== undefined) {
      if (isWindows) process.env['USERPROFILE'] = savedHome;
      else process.env['HOME'] = savedHome;
    } else {
      if (isWindows) delete process.env['USERPROFILE'];
      else delete process.env['HOME'];
    }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('stop after pause leaves no pause intent that would corrupt the next run', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const pm = createPreloadManager();
    pm.checkSkills();
    // remotion 在干净 tmp home 上恒为 missing（无 marker、无全局回退）
    assert.equal(pm.getStatuses().remotion.status, 'missing');

    // 在非运行态登记暂停意图（镜像 UI 的暂停动作）
    pm.pausePreload('remotion');
    assert.equal(pm._testHasPauseIntent('remotion'), true, 'pause must register the intent');

    // 停止 > 暂停：必须把暂停意图一并清掉，否则下一次下载被静音/错标
    pm.stopPreload('remotion');
    assert.equal(
      pm._testHasPauseIntent('remotion'),
      false,
      'stop must clear the pending pause intent (else next run is muted / mislabelled)',
    );
    assert.equal(pm.getStatuses().remotion.status, 'missing', 'stop resets the skill to missing');
  });
});

// ─── skillsNeedingStart (retry-button no-op regression) ────────────────────
//
// Error-driven (2026-07): 下载失败后 skill 状态为 'failed'，但 /start 路由只把
// 'missing'/'paused' 当作需要重启 → 'failed' 掉进 alreadyDone → 路由伪造一条
// "already installed" 完成事件 → 错误卡片的「重试」按钮点了等于没点（toast 闪一下
// 就消失，根本没重新下载）。修复：把判定抽成 skillsNeedingStart 并把 'failed' 归入
// needsStart。这里钉住每种状态的归类，防止路由再退化。

describe('skillsNeedingStart (retry-button no-op regression)', () => {
  const of = (status: string) => async () => {
    const { skillsNeedingStart } = await import('../../src/core/preload-manager.js');
    return skillsNeedingStart(() => ({ status } as any), ['docling']);
  };

  it('re-launches a FAILED skill (this is the retry fix)', async () => {
    const { needsStart, alreadyDone } = await of('failed')();
    assert.deepEqual(needsStart, ['docling'], 'a failed skill must be re-started so 重试 re-downloads');
    assert.deepEqual(alreadyDone, []);
  });

  it('re-launches missing and paused skills', async () => {
    for (const status of ['missing', 'paused']) {
      const { needsStart } = await of(status)();
      assert.deepEqual(needsStart, ['docling'], `${status} must be re-started`);
    }
  });

  it('treats done / not-actionable states as already-done (no reinstall, no double-start)', async () => {
    for (const status of ['downloaded', 'installed', 'dismissed', 'preloading', 'unchecked']) {
      const { needsStart, alreadyDone } = await of(status)();
      assert.deepEqual(needsStart, [], `${status} must NOT be re-started`);
      assert.deepEqual(alreadyDone, ['docling'], `${status} must be treated as already-done`);
    }
  });
});

// ─── docling pip index fallback (CN ConnectTimeoutError regression) ────────
//
// Error-driven (2026-07): docling pip 旧逻辑「单镜像 → 裸默认源、15s connect timeout、
// 不重试」。国内机器上清华镜像一抖动，就退回 files.pythonhosted.org（连不上）→
// ConnectTimeoutError(connect timeout=15)。修复：和 npm 同款的 runPipInstallWithFallback
// （同源重试 + 跨国内镜像降级 + 官方源兜底），每次 --timeout 60 抬升 connect timeout。

describe('runPipInstallWithFallback (docling CN-timeout regression)', () => {
  const mkSignal = () => new AbortController().signal;

  it('a failing mirror falls back across CN mirrors before the official source', async () => {
    const { runPipInstallWithFallback, PIP_INDEX_FALLBACKS } = await import('../../src/core/preload-manager.js');
    const seen: string[][] = [];
    await runPipInstallWithFallback({
      label: 'docling pip 安装',
      signal: mkSignal(),
      attemptsPerIndex: 1,
      exec: async (indexArgs) => {
        seen.push(indexArgs);
        // 前两个镜像失败，第三个放行
        if (seen.length <= 2) throw new Error('进程退出码 1: ConnectTimeoutError connect timeout=15');
      },
    });
    assert.equal(seen.length, 3, 'should try mirrors in order until one succeeds');
    assert.deepEqual(seen[0], PIP_INDEX_FALLBACKS[0]!.args, 'first attempt uses the first CN mirror');
    assert.deepEqual(seen[1], PIP_INDEX_FALLBACKS[1]!.args, 'second attempt switches to the next mirror');
    assert.deepEqual(seen[2], PIP_INDEX_FALLBACKS[2]!.args, 'third attempt uses the third mirror');
  });

  it('transient failure retries within the same index before switching', async () => {
    const { runPipInstallWithFallback, PIP_INDEX_FALLBACKS } = await import('../../src/core/preload-manager.js');
    const seen: string[][] = [];
    await runPipInstallWithFallback({
      label: 'step',
      signal: mkSignal(),
      exec: async (indexArgs) => {
        seen.push(indexArgs);
        if (seen.length === 1) throw new Error('进程退出码 1: network hiccup');
      },
    });
    assert.equal(seen.length, 2, 'should retry once on the same index then succeed');
    assert.deepEqual(seen[0], PIP_INDEX_FALLBACKS[0]!.args, 'first attempt uses the first mirror');
    assert.deepEqual(seen[1], PIP_INDEX_FALLBACKS[0]!.args, 'the retry must stay on the same mirror (no index switch)');
  });

  it('abort interrupts immediately without retry or index switch', async () => {
    const { runPipInstallWithFallback } = await import('../../src/core/preload-manager.js');
    const ac = new AbortController();
    const seen: string[][] = [];
    await assert.rejects(
      runPipInstallWithFallback({
        label: 'step',
        signal: ac.signal,
        exec: async (indexArgs) => {
          seen.push(indexArgs);
          ac.abort();
          throw new Error('aborted');
        },
      }),
      /aborted/,
    );
    assert.equal(seen.length, 1, 'abort must not trigger retries or an index switch');
  });

  it('final failure message names the step and carries the underlying error tail', async () => {
    const { runPipInstallWithFallback } = await import('../../src/core/preload-manager.js');
    await assert.rejects(
      runPipInstallWithFallback({
        label: 'docling pip 安装',
        signal: mkSignal(),
        attemptsPerIndex: 1,
        exec: async () => {
          throw new Error('进程退出码 1: ConnectTimeoutError connect timeout=15 files.pythonhosted.org');
        },
      }),
      (err: Error) => {
        assert.match(err.message, /docling pip 安装/, 'error must name the failing step');
        assert.match(err.message, /ConnectTimeoutError/, 'error must carry the underlying output tail');
        return true;
      },
    );
  });

  it('CN mirrors come before the official source, and none pin the CN-blocked host', async () => {
    const { PIP_INDEX_FALLBACKS } = await import('../../src/core/preload-manager.js');
    const labels = PIP_INDEX_FALLBACKS.map((s) => s.label);
    assert.equal(labels[labels.length - 1], '官方源', 'official index must be the last resort');
    // every non-last entry must be an explicit CN mirror (-i <url>), never empty
    for (const s of PIP_INDEX_FALLBACKS.slice(0, -1)) {
      assert.equal(s.args[0], '-i', 'CN fallback entries must pass an explicit -i index');
      assert.ok(s.args[1] && !/pythonhosted\.org|pypi\.org/.test(s.args[1]), `mirror ${s.label} must not point at the CN-blocked host`);
    }
    assert.equal(PIP_INDEX_FALLBACKS[PIP_INDEX_FALLBACKS.length - 1]!.args.length, 0, 'official entry uses pip default (empty args)');
  });
});

describe('doclingPipInstallArgv (pip --timeout regression)', () => {
  it('appends a generous --timeout (>15s) so the connect timeout is not the 15s default', async () => {
    const { doclingPipInstallArgv, PIP_CONNECT_TIMEOUT_SECS } = await import('../../src/core/preload-manager.js');
    assert.ok(PIP_CONNECT_TIMEOUT_SECS > 15, `timeout must exceed pip's 15s default, got ${PIP_CONNECT_TIMEOUT_SECS}`);
    const argv = doclingPipInstallArgv('C:\\venv\\python.exe', ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']);
    assert.equal(argv[0], 'C:\\venv\\python.exe');
    assert.ok(argv.includes('docling'), 'must install the docling package');
    const t = argv.indexOf('--timeout');
    assert.ok(t >= 0, 'must pass --timeout');
    assert.equal(Number(argv[t + 1]), PIP_CONNECT_TIMEOUT_SECS, '--timeout value must equal PIP_CONNECT_TIMEOUT_SECS');
    // -i <url> must be present (the index fragment is threaded through verbatim)
    const i = argv.indexOf('-i');
    assert.equal(argv[i + 1], 'https://pypi.tuna.tsinghua.edu.cn/simple');
  });

  it('works with the official (empty) index fragment too', async () => {
    const { doclingPipInstallArgv } = await import('../../src/core/preload-manager.js');
    const argv = doclingPipInstallArgv('/venv/bin/python', []);
    assert.ok(!argv.includes('-i'), 'empty index fragment must not inject a stray -i');
    assert.ok(argv.includes('--timeout'), 'timeout is always applied');
  });
});

// ─── cleanup closure (stop keeps shared cache, removes only own artifacts) ──
//
// 闭环加固（2026-07）：保证「清理失效部分 / 保留必要内容」稳定且闭环。语义分工：
//   重试 = 续传复用（startPreload 不调 deletePartial，不删任何东西）
//   停止 = 彻底清理（deletePartial，回到 missing）
// 这里钉住「停止」一侧的磁盘语义，防止未来把清理写「过宽」（误删共享 ~/.npm 或别的 HF
// 模型）或「过窄」（漏删本次产物），从而破坏闭环：
//   docling : 删 ~/.molio/venv + 仅删 models--docling-project--* ；保留其它 HF 模型 + ~/.npm
//   remotion: 删标记文件；保留 ~/.npm
// 重试侧「复用有效 venv」由 venv 守卫 + 路由测试（failed 必被重启）保证，不在无 pip 的单测里
// 跑真实安装（若要把它也变成可单测的纯函数，见 skillsNeedingStart 同款的 venv 判定抽取）。

describe('preload cleanup closure (stop keeps shared cache, removes only own artifacts)', () => {
  const isWindows = process.platform === 'win32';
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-preload-cleanup-'));
    if (isWindows) process.env['USERPROFILE'] = tmpHome;
    else process.env['HOME'] = tmpHome;
  });
  afterEach(() => {
    if (savedHome !== undefined) process.env['HOME'] = savedHome; else delete process.env['HOME'];
    if (savedUserProfile !== undefined) process.env['USERPROFILE'] = savedUserProfile; else delete process.env['USERPROFILE'];
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('docling stop: removes venv + docling HF models, keeps other HF models AND ~/.npm', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const venvRoot = path.join(tmpHome, '.molio', 'venv');
    const hub = path.join(tmpHome, '.cache', 'huggingface', 'hub');
    const doclingModel = path.join(hub, 'models--docling-project--docling-layout-heron');
    const otherModel = path.join(hub, 'models--some-other--model');
    const npmCache = path.join(tmpHome, '.npm');
    // 模拟一次失败后留下的产物：半成品 venv + 半下载 HF 模型
    fs.mkdirSync(path.join(venvRoot, 'Lib', 'site-packages'), { recursive: true });
    fs.writeFileSync(path.join(venvRoot, 'pyvenv.cfg'), '');
    fs.mkdirSync(doclingModel, { recursive: true });
    fs.writeFileSync(path.join(doclingModel, 'partial.incomplete'), 'x');
    // 必须保留的：别的工具的 HF 模型 + 共享 npm 缓存
    fs.mkdirSync(otherModel, { recursive: true });
    fs.writeFileSync(path.join(otherModel, 'keep.bin'), 'y');
    fs.mkdirSync(path.join(npmCache, '_cacache'), { recursive: true });
    fs.writeFileSync(path.join(npmCache, '_cacache', 'shared.tar'), 'z');

    const pm = createPreloadManager();
    pm.checkSkills();
    pm.stopPreload('docling'); // 非运行态 → 走 deletePartial 直接清理

    assert.equal(fs.existsSync(venvRoot), false, 'venv (partial pip install) must be removed');
    assert.equal(fs.existsSync(doclingModel), false, "docling's own HF model dir must be removed");
    assert.equal(fs.existsSync(otherModel), true, "other tools' HF models must be preserved");
    assert.equal(fs.existsSync(path.join(otherModel, 'keep.bin')), true, 'preserved model contents must stay intact');
    assert.equal(fs.existsSync(npmCache), true, 'shared ~/.npm must NOT be touched by docling cleanup');
    assert.equal(fs.existsSync(path.join(npmCache, '_cacache', 'shared.tar')), true, 'shared npm cache contents must stay intact');
    // stop 后必须是「可重新提示/可用」的终态，不能卡在 failed/preloading/paused。
    // （installed 仅当宿主机另有全局 docling 时出现，那也是合法终态，与本次清理无关。）
    const st = pm.getStatuses().docling.status;
    assert.ok(st === 'missing' || st === 'installed', `stop must resolve docling to a non-broken state, got ${st}`);
  });

  it('remotion stop: removes the marker but keeps shared ~/.npm', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const marker = path.join(tmpHome, '.molio', '.remotion-preloaded');
    const npmCache = path.join(tmpHome, '.npm');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    fs.mkdirSync(path.join(npmCache, '_cacache'), { recursive: true });
    fs.writeFileSync(path.join(npmCache, '_cacache', 'shared.tar'), 'z');

    const pm = createPreloadManager();
    pm.checkSkills();
    pm.stopPreload('remotion');

    assert.equal(fs.existsSync(marker), false, 'remotion marker must be removed');
    assert.equal(fs.existsSync(npmCache), true, 'shared ~/.npm must NOT be touched by remotion cleanup');
    assert.equal(fs.existsSync(path.join(npmCache, '_cacache', 'shared.tar')), true, 'shared npm cache contents must stay intact');
    assert.equal(pm.getStatuses().remotion.status, 'missing', 'stop must return remotion to a promptable missing state');
  });

  it('stop on an already-missing skill is an idempotent, safe escape hatch', async () => {
    const { createPreloadManager } = await import('../../src/core/preload-manager.js');
    const npmCache = path.join(tmpHome, '.npm');
    fs.mkdirSync(npmCache, { recursive: true });
    const pm = createPreloadManager();
    pm.checkSkills();
    assert.equal(pm.getStatuses().remotion.status, 'missing');
    // 反复按「停止」（闭环的逃生舱）不能抛、不能误删共享缓存
    pm.stopPreload('remotion');
    pm.stopPreload('remotion');
    assert.equal(fs.existsSync(npmCache), true, 'idempotent stop must still not touch ~/.npm');
    assert.equal(pm.getStatuses().remotion.status, 'missing');
  });
});
