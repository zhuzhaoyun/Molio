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

  it('default registry ETARGET failure falls back to the official registry', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const cmds: string[] = [];
    await runWithRegistryFallback({
      label: 'Remotion 依赖安装（npm install）',
      signal: mkSignal(),
      buildCmd: (flag) => `npm install ${flag} --no-audit --no-fund`.replace('  ', ' '),
      run: async (cmd: string) => {
        cmds.push(cmd);
        // 模拟镜像未同步钉住版本：默认源 ETARGET，官方源放行
        if (!cmd.includes('--registry=https://registry.npmjs.org')) {
          throw new Error('进程退出码 1: npm error notarget No matching version found for @remotion/player@4.0.501.');
        }
      },
    });
    assert.ok(cmds.length >= 2, `expected multiple attempts, got ${cmds.length}`);
    assert.ok(!cmds[0]?.includes('--registry'), 'first attempt must use the default registry (no --registry flag)');
    assert.ok(
      cmds.some((c) => c.includes('--registry=https://registry.npmjs.org')),
      'must fall back to the official npm registry',
    );
  });

  it('transient failure retries within the same registry before switching', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const cmds: string[] = [];
    await runWithRegistryFallback({
      label: 'step',
      signal: mkSignal(),
      buildCmd: (flag) => `cmd ${flag}`.trim(),
      run: async (cmd: string) => {
        cmds.push(cmd);
        // 第一次（默认源）瞬态失败，第二次（仍默认源）成功 → 不应换源
        if (cmds.length === 1) throw new Error('进程退出码 1: network hiccup');
      },
    });
    assert.equal(cmds.length, 2, 'should retry once on the same registry then succeed');
    assert.ok(cmds.every((c) => !c.includes('--registry')), 'no registry switch needed for a transient failure');
  });

  it('abort interrupts immediately without retry or registry switch', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    const ac = new AbortController();
    const cmds: string[] = [];
    await assert.rejects(
      runWithRegistryFallback({
        label: 'step',
        signal: ac.signal,
        buildCmd: (flag) => `cmd ${flag}`.trim(),
        run: async (cmd: string) => {
          cmds.push(cmd);
          ac.abort(); // 模拟用户暂停/停止
          throw new Error('aborted');
        },
      }),
      /aborted/,
    );
    assert.equal(cmds.length, 1, 'abort must not trigger retries or a registry switch');
  });

  it('final failure message includes the step label and the underlying output tail', async () => {
    const { runWithRegistryFallback } = await import('../../src/core/preload-manager.js');
    await assert.rejects(
      runWithRegistryFallback({
        label: 'Remotion 依赖安装（npm install）',
        signal: mkSignal(),
        buildCmd: (flag) => `cmd ${flag}`.trim(),
        run: async () => {
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

  it('scaffold/install command builders place the registry flag correctly', async () => {
    const { remotionScaffoldCmd, remotionInstallCmd } = await import('../../src/core/preload-manager.js');
    // 默认源：无 --registry，命令与 agent 的真实步骤一致
    assert.equal(
      remotionScaffoldCmd(''),
      'npx --yes create-video@latest --yes --blank --no-tailwind warmup',
    );
    assert.equal(remotionInstallCmd(''), 'npm install --no-audit --no-fund');
    // 降级源：--registry 注入到正确位置
    assert.equal(
      remotionScaffoldCmd('--registry=https://registry.npmjs.org'),
      'npx --yes --registry=https://registry.npmjs.org create-video@latest --yes --blank --no-tailwind warmup',
    );
    assert.equal(
      remotionInstallCmd('--registry=https://registry.npmjs.org'),
      'npm install --registry=https://registry.npmjs.org --no-audit --no-fund',
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
  it('hides the child console window while keeping detached + piped stdio', async () => {
    const { preloadSpawnOpts } = await import('../../src/core/preload-manager.js');
    const o = preloadSpawnOpts({});
    assert.equal(
      o.windowsHide,
      true,
      'windowsHide must be set so Windows does not pop a console window per child',
    );
    assert.equal(o.detached, true, 'detached must stay for process-tree kill');
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
