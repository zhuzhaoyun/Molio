/**
 * PreloadManager — checks whether heavy skill tools are installed and manages
 * background preloading so the user doesn't hit a long download when they first
 * need docling, remotion, etc.
 *
 * Lifecycle:
 *   daemon startup → checkSkills() → web UI queries status → user clicks
 *   "download" → startPreload() → background child_process → progress via
 *   onProgress listeners → UI updates.
 *
 * "Dismissed" state is persisted in config.json so repeated prompts don't
 * annoy the user.
 */

import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig, saveConfig, mergeConfig } from './config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PreloadableSkill = 'docling' | 'remotion';

export const PRELOADABLE_SKILLS: PreloadableSkill[] = ['docling', 'remotion'];

/**
 * Status of a preloadable skill.
 * - unchecked: not yet checked (initial state on startup before checkSkills completes)
 * - installed: the tool is available on the system (no preload needed)
 * - missing: tool not found, needs preloading
 * - dismissed: user said "don't show again"
 * - preloading: download in progress
 * - failed: download failed
 * - downloaded: preload completed successfully
 */
export type SkillStatus =
  | { status: 'unchecked' }
  | { status: 'installed' }
  | { status: 'missing' }
  | { status: 'dismissed' }
  | { status: 'preloading'; progress: number; message: string }
  | { status: 'failed'; error: string }
  | { status: 'paused' }
  | { status: 'downloaded' };

export interface PreloadProgressEvent {
  skill: PreloadableSkill;
  status: 'preloading' | 'completed' | 'failed' | 'paused' | 'stopped';
  progress: number; // 0–100
  message: string;
}

// ─── Skill metadata ─────────────────────────────────────────────────────────

interface SkillMeta {
  label: string;
  description: string;
  /** Check if the tool is already available on the system. */
  detectInstalled(): boolean;
  /** Start the preload process (pip install, scaffold, etc.).
   *  `signal` lets PreloadManager abort mid-run (pause/stop); the spawned
   *  process tree is killed and the returned promise rejects with an
   *  AbortError — PreloadManager's catch distinguishes pause vs stop vs
   *  real failure via the intent sets. */
  preload(onProgress: (pct: number, msg: string) => void, signal: AbortSignal): Promise<void>;
}

const SKILL_META: Record<PreloadableSkill, SkillMeta> = {
  docling: {
    label: 'docling',
    description: '解析 PDF/Office 文档 → Markdown（需下载 AI 模型 ~500MB）',
    detectInstalled(): boolean {
      // Cross-platform: venv binary → PATH → every known python's scripts dir.
      // Does NOT rely on the daemon's PATH, so a global/user/conda docling that
      // isn't on PATH (common on Windows) is still detected → no re-install and
      // the real location is reported via getPreloadLocations().
      return computeLocateDocling() !== null;
    },
    async preload(onProgress, signal) {
      const venvPy = venvPythonPath();
      const isWin = process.platform === 'win32';
      // The located path can change as we install; keep the cache honest so the
      // /status API reports the right place during/after this run.
      invalidateDoclingLoc();

      // Phase 0: docling requires Python >=3.10. On a box whose only python3
      // is 3.9 (older macOS), installing into a 3.9 venv fails inside
      // pyobjc-core's source build on modern clang — a cryptic error that
      // earlier swallowed the real cause. Detect up front and give an
      // actionable message instead.
      onProgress(2, '检测 Python 版本（docling 需要 ≥3.10）...');
      const pyInfo = findPythonAtLeast(3, 10);
      if (!pyInfo.bin) {
        const have = pyInfo.version ? `${pyInfo.version[0]}.${pyInfo.version[1]}` : '未检测到 Python';
        const how = process.platform === 'darwin'
          ? 'brew install python@3.12（推荐，无需 sudo）或从 python.org 下载安装包'
          : process.platform === 'win32'
            ? '从 python.org 下载 3.12 安装包，或用 winget install Python.Python.3.12（安装时勾选 Add to PATH）'
            : 'sudo apt install python3.12 python3.12-venv（Debian/Ubuntu）或对应包管理器';
        throw new Error(`docling 需要 Python ≥3.10，但本机最高只检测到 ${have}。请先安装 Python 3.10+：${how}，安装后重试即可。`);
      }

      // Phase 1: ensure a dedicated venv exists at ~/.molio/venv, built with a
      // >=3.10 interpreter. If a stale venv from an older python (e.g. 3.9) is
      // present, rebuild it — otherwise pip would target the wrong version.
      // We install into a venv (not the system Python) so:
      //  - no PEP 668 "externally-managed-environment" rejections
      //  - the CLI lands at a fixed path augmentPath exposes to the agent
      //  - no pollution of / conflict with the user's other Python projects
      // All python/pip/docling invocations use runArgv (no shell) so paths with
      // spaces (Windows usernames, conda env dirs) never break the command.
      onProgress(5, `准备 Python ${pyInfo.version[0]}.${pyInfo.version[1]} 隔离环境...`);
      const venvVer = fs.existsSync(venvPy) ? versionOfAbs(venvPy) : null;
      const venvStale = !venvVer || venvVer[0] < 3 || (venvVer[0] === 3 && venvVer[1] < 10);
      if (fs.existsSync(venvRoot()) && venvStale) {
        onProgress(6, '旧 Python 环境版本过低，重建中...');
        fs.rmSync(venvRoot(), { recursive: true, force: true });
      }
      if (!fs.existsSync(venvPy)) {
        onProgress(8, '创建隔离 Python 环境...');
        await runArgv([pyInfo.bin, '-m', 'venv', venvRoot()], { timeout: 60_000, signal });
        if (!fs.existsSync(venvPy)) {
          throw new Error('无法创建 Python venv，请确认 Python 3.10+ 安装完整');
        }
      }

      // Phase 2: pip install docling (8 → 55). We install through a chain of
      // PyPI mirrors with per-mirror retry (runPipInstallWithFallback) — the
      // same defence-in-depth the remotion preload uses for npm. The previous
      // code tried ONE mirror then fell straight back to pip's DEFAULT index
      // (pypi.org / files.pythonhosted.org) with pip's 15s connect timeout and
      // no retry; on mainland-China boxes that default host is routinely
      // unreachable, so a single transient mirror hiccup cascaded into a
      // ConnectTimeoutError and the whole preload failed. The chain tries
      // several CN mirrors (each retried — they host the wheels too, so pip
      // never touches the blocked default host while a mirror works) before the
      // official source, and every attempt uses a generous --timeout so a
      // slow-but-alive host isn't killed at 15s.
      onProgress(12, '正在安装 docling Python 包（含 PyTorch，国内源优先、失败自动换源重试）...');
      let pipOk = false;
      let lastPipErr = '';
      try {
        await runPipInstallWithFallback({
          label: 'docling pip 安装',
          signal,
          onProgress: (msg) => onProgress(30, msg),
          exec: (indexArgs) => runArgv(doclingPipInstallArgv(venvPy, indexArgs), {
            timeout: 600_000,
            signal,
            onLine(line) {
              if (line.includes('Downloading') || line.includes('Installing collected packages')) {
                onProgress(20, line.trim());
              }
            },
          }),
        });
        pipOk = true;
      } catch (err) {
        if (signal.aborted) throw err; // pause/stop — don't swallow as a pip failure
        lastPipErr = err instanceof Error ? err.message : String(err);
        pipOk = false;
      }
      if (!pipOk || !doclingVenvBinaryPresent()) {
        const detail = lastPipErr ? `（${lastPipErr.slice(0, 240)}）` : '（未生成 docling 可执行文件）';
        throw new Error(`docling 安装失败${detail}。可手动运行：${q(venvPy)} -m pip install docling`);
      }

      // Phase 3: Model warmup (55 → 100). Run a no-op conversion so docling
      // downloads its layout + table models into ~/.cache/huggingface now,
      // not on the user's first real conversion. Failure here is non-fatal —
      // the models will download on first real use. (`/dev/null`/`NUL` is passed
      // as a literal empty-input file argument; stderr is captured via the pipe,
      // so no shell `2>&1` redirection is needed.)
      onProgress(60, '预热 AI 模型（喂最小 PDF 触发 layout/table 模型下载，~500MB；部分镜像可能只下到一部分，属正常）...');
      try {
        const outDir = path.join(os.tmpdir(), 'molio-docling-preload');
        // Feed docling a minimal PDF (NOT markdown, NOT /dev/null). Empty input
        // is rejected at format detection; markdown routes to SimplePipeline —
        // neither loads the layout/table AI models (verified 2026-07: HF cache
        // stayed empty). A PDF forces StandardPdfPipeline, which downloads the
        // models at init — the whole point of warmup. The bundled base64 PDF
        // keeps this dependency-free and cross-platform.
        fs.mkdirSync(outDir, { recursive: true });
        const warmupInput = path.join(outDir, 'warmup.pdf');
        fs.writeFileSync(warmupInput, Buffer.from(DOCLING_WARMUP_PDF_B64, 'base64'));
        // Default the model download to the HF mirror (default hf.co is slow /
        // unreachable from mainland China). Only set when the user hasn't
        // chosen their own HF_ENDPOINT, and only for this child process (env
        // overlay, never touches the daemon env). Now that warmup truly loads
        // models, this mirror actually gets exercised.
        const hfEnv: Record<string, string> = {};
        if (!process.env['HF_ENDPOINT']) hfEnv['HF_ENDPOINT'] = 'https://hf-mirror.com';
        await runArgv(doclingWarmupArgv(isWin, venvPy, warmupInput, outDir), {
          timeout: 600_000,
          signal,
          env: hfEnv,
          onLine(line) {
            if (line.toLowerCase().includes('download') || line.toLowerCase().includes('model')) {
              onProgress(70, line.trim());
            }
          },
        });
      } catch (err) {
        if (signal.aborted) throw err; // pause/stop propagates
        onProgress(95, '模型预热跳过（首次转换时会自动下载）');
      }

      onProgress(100, 'docling 就绪');
    },
  },

  remotion: {
    label: 'Remotion',
    description: 'React 视频制作框架（首次需下载 npm 依赖）',
    detectInstalled(): boolean {
      // "Installed" here means "already preloaded" — we don't claim remotion
      // is present just because node exists (that led to never prompting).
      // The marker is written after a successful cache warmup.
      return fs.existsSync(remotionPreloadMarker());
    },
    async preload(onProgress, signal) {
      // Goal: warm the FULL remotion dependency tree into the npm cache so the
      // agent's real `npx create-video` + `npm install` (in the vault) is
      // mostly cache hits — fast AND resilient to the network hiccups that
      // left earlier half-scaffolded projects (skeleton dir, no node_modules).
      //
      // We reproduce the agent's exact steps in a throwaway dir — scaffold a
      // real Remotion project, then install its real (transitive) deps — and
      // delete the dir afterwards. Only the npm cache survives, which is
      // exactly what the agent reuses. NOTE: current create-video versions no
      // longer auto-install deps (the scaffold only copies the template — it
      // tells you to run `npm i` yourself), so the install step below is what
      // downloads the whole tree.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-remotion-warmup-'));
      const projDir = path.join(tmpDir, 'warmup');

      // runStep: run one step (scaffold or install) with transient retry AND
      // npm-registry fallback (see runWithRegistryFallback). Registry fallback
      // is the core of the 2026-07 ETARGET fix: remotion releases ~20 lockstep
      // packages; mirrors (npmmirror et al.) sync them lazily per-package, so
      // right after a release the pinned version commonly exists for
      // @remotion/cli but NOT for a transitive package like @remotion/player
      // → `npm install` exits 1 with ETARGET, and retrying the SAME registry
      // is pointless until the mirror catches up (minutes to hours). Falling
      // back to the official registry (the sync source — always complete)
      // makes the preload succeed regardless of mirror lag.
      //
      // Deliberately NO `--prefer-offline` on the install: it makes npm skip
      // staleness checks on cached packuments, so a packument cached while the
      // mirror still lacked the pinned version would keep throwing ETARGET
      // even AFTER the mirror synced — turning transient lag into a
      // persistent failure. Online mode still reuses cached tarballs via
      // integrity matching, so cache-warming is unaffected.
      //
      // WINDOWS CONSOLE-WINDOW FIX: on Windows we do NOT run these through
      // `cmd /c`. `cmd.exe` and the npm `.exe`/`.cmd` shims are console apps
      // that re-spawn node as console-windowed grandchildren, and npm's own
      // @npmcli/promise-spawn does NOT set windowsHide — so spawn options
      // alone can't hide the tree. Instead we invoke node + the npm/npx JS
      // entry directly (runArgv, hidden, in-process): `npm install` then runs
      // with no grandchildren at all. resolveNpmEntry needs npm on PATH (dev);
      // if it's absent (e.g. a packaged build without npm, where remotion
      // preload is optional) we fall back to the shell form. POSIX has no
      // per-process console window, so it keeps the simple shell form.
      // Pause/stop (signal.aborted) never retries — it propagates.
      const isWin = process.platform === 'win32';
      const nodeBin = process.execPath;
      const npmJs = isWin ? resolveNpmEntry('npm') : null;
      const npxJs = isWin ? resolveNpmEntry('npx') : null;
      const runShellOrArgv = (cmd: string, argv: string[] | null, runOpts: RunOpts) =>
        argv ? runArgv(argv, runOpts) : runProcess(cmd, runOpts);

      const runStep = async (
        label: string,
        kind: 'scaffold' | 'install',
        cwd: string | undefined,
        pct: number,
      ) => {
        await runWithRegistryFallback({
          label,
          signal,
          onProgress: (msg) => onProgress(pct, msg),
          exec: (registryFlag) => {
            const runOpts: RunOpts = {
              // 900s (vs docling's 600s): the official-registry fallback stage
              // can spend several minutes just resolving metadata from a slow
              // CN link (measured: >240s for a packument-only dry run) before
              // downloading hundreds of tarballs. A too-short timeout would
              // neuter the fallback; and even if it DOES time out, the
              // mirror-lag that forced the fallback typically self-heals within
              // minutes (our stage-1 requests trigger npmmirror's on-demand
              // sync), so the final npmmirror stage — ~20min after the first
              // attempt — usually succeeds.
              timeout: 900_000,
              cwd,
              signal,
              onLine(line) {
                if (line.includes('added') || line.toLowerCase().includes('package')) {
                  onProgress(pct, line.trim());
                }
              },
            };
            if (kind === 'scaffold') {
              const argv = isWin && npxJs ? remotionScaffoldArgv(nodeBin, npxJs, registryFlag) : null;
              return runShellOrArgv(remotionScaffoldCmd(registryFlag), argv, runOpts);
            }
            const argv = isWin && npmJs ? remotionInstallArgv(nodeBin, npmJs, registryFlag) : null;
            return runShellOrArgv(remotionInstallCmd(registryFlag), argv, runOpts);
          },
        });
      };

      try {
        onProgress(10, '拉取 Remotion 脚手架（create-video）...');
        // `--yes` skips the interactive prompts; the scaffold only copies the
        // template (no install — that's the next step).
        await runStep('Remotion 脚手架（create-video）', 'scaffold', tmpDir, 30);

        if (!fs.existsSync(projDir)) {
          throw new Error('Remotion 脚手架未生成（create-video 可能交互失败或网络中断）');
        }

        onProgress(55, '安装完整 Remotion 依赖树（暖缓存）...');
        // Install the full (transitive) tree so every tarball lands in the
        // cache for the agent's later real install to reuse.
        await runStep('Remotion 依赖安装（npm install）', 'install', projDir, 80);

        if (!fs.existsSync(path.join(projDir, 'node_modules', 'remotion'))) {
          throw new Error('Remotion 依赖树未装全（node_modules/remotion 缺失）');
        }

        // Marker = "warmup done"; the npm cache is what actually persists.
        try {
          fs.writeFileSync(remotionPreloadMarker(), new Date().toISOString());
        } catch { /* best-effort */ }

        onProgress(100, 'Remotion 依赖缓存就绪');
      } finally {
        // Always delete the throwaway project; only the npm cache survives.
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    },
  },
};

// ─── npm registry fallback (remotion preload) ───────────────────────────────

/** Scaffold command (POSIX shell form). `registryFlag` empty = user's default
 *  registry, else a full `--registry=<url>`; npx accepts npm config flags
 *  before the package spec. On Windows the argv form (remotionScaffoldArgv) is
 *  preferred to avoid a console window; this shell form is the fallback. */
export function remotionScaffoldCmd(registryFlag: string): string {
  const flag = registryFlag ? `${registryFlag} ` : '';
  return `npx --yes ${flag}create-video@latest --yes --blank --no-tailwind warmup`;
}

/** Dependency-install command (POSIX shell form; warms the npm cache). */
export function remotionInstallCmd(registryFlag: string): string {
  const flag = registryFlag ? `${registryFlag} ` : '';
  return `npm install ${flag}--no-audit --no-fund`;
}

/** Scaffold argv (Windows): node + npx JS entry run directly, no cmd.exe, so
 *  npx runs in-process (hidden). create-video itself remains npx's child. */
export function remotionScaffoldArgv(node: string, npxJs: string, registryFlag: string): string[] {
  return [
    node, npxJs,
    ...(registryFlag ? [registryFlag] : []),
    '--yes', 'create-video@latest', '--yes', '--blank', '--no-tailwind', 'warmup',
  ];
}

/** Install argv (Windows): node + npm JS entry run directly → `npm install`
 *  executes in-process with NO grandchildren → no console window. */
export function remotionInstallArgv(node: string, npmJs: string, registryFlag: string): string[] {
  return [node, npmJs, 'install', ...(registryFlag ? [registryFlag] : []), '--no-audit', '--no-fund'];
}

/** Map an npm/npx shim directory (the dir of the `npm`/`npx` found on PATH) to
 *  its JS entry: `<shimDir>/node_modules/npm/bin/<name>-cli.js`. Pure (no IO)
 *  so it's unit-testable; existence is checked by resolveNpmEntry. */
export function npmCliJsFromDir(shimDir: string, name: 'npm' | 'npx'): string {
  return path.join(shimDir, 'node_modules', 'npm', 'bin', `${name}-cli.js`);
}

let _npmEntryCache: Partial<Record<'npm' | 'npx', string | null>> = {};
export function invalidateNpmEntryCache(): void { _npmEntryCache = {}; }

/** Resolve the npm/npx JS entry from whatever `npm`/`npx` is on PATH (so nvm,
 *  global, and Program-Files installs all work in dev). Returns null when npm
 *  isn't on PATH (e.g. a packaged build that doesn't bundle it) — callers then
 *  fall back to the shell form. Cached; invalidate when PATH may have changed. */
export function resolveNpmEntry(name: 'npm' | 'npx'): string | null {
  if (name in _npmEntryCache) return _npmEntryCache[name] ?? null;
  let found: string | null = null;
  try {
    const probe = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
    const out = execSync(probe, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true,
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first) {
      const cli = npmCliJsFromDir(path.dirname(first), name);
      if (fs.existsSync(cli)) found = cli;
    }
  } catch { /* npm/npx not on PATH */ }
  _npmEntryCache[name] = found;
  return found;
}

/** Ordered npm registries to try: the user's default (empty flag — fast, and
 *  whatever they've configured), then the official registry (the sync source:
 *  version lists are always complete, so mirror sync lag can't cause a
 *  persistent ETARGET; slower from mainland China but fine for a background
 *  preload), then the npmmirror mirror (fast in China, helps users whose
 *  default is the slow official registry). */
export const NPM_REGISTRY_FALLBACKS: ReadonlyArray<{ label: string; flag: string }> = [
  { label: '默认源', flag: '' },
  { label: '官方源', flag: '--registry=https://registry.npmjs.org' },
  { label: 'npmmirror 镜像', flag: '--registry=https://registry.npmmirror.com' },
];

export interface RegistryFallbackOpts {
  /** Step name shown in progress + final error. */
  label: string;
  /** Run one attempt for a given registry flag (may be empty). The caller
   *  decides shell-vs-argv per platform; rejects on non-zero exit / timeout. */
  exec: (registryFlag: string) => Promise<void>;
  signal: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Transient retries per registry before switching. Default 2. */
  attemptsPerRegistry?: number;
}

/**
 * Run an npm-family step with transient retry per registry and fallback ACROSS
 * registries (see NPM_REGISTRY_FALLBACKS). Same-registry retries cover network
 * blips (a single failed tarball → npm exit 1); cross-registry fallback covers
 * mirror sync lag (a lockstep release whose transitive packages haven't
 * reached the mirror yet → ETARGET on every same-registry retry). Succeeds as
 * soon as any attempt succeeds; throws only when every registry is exhausted,
 * with the step label + last error (including the child's combined output
 * tail) so the UI/log pinpoints the failure. Pause/stop (signal.aborted)
 * aborts immediately with the original error — never retried, never switched.
 */
export async function runWithRegistryFallback(opts: RegistryFallbackOpts): Promise<void> {
  if (opts.signal.aborted) throw new Error('aborted');
  const attempts = opts.attemptsPerRegistry ?? 2;
  let lastErr: unknown = null;
  for (const source of NPM_REGISTRY_FALLBACKS) {
    for (let attempt = 1; attempt <= attempts && !opts.signal.aborted; attempt++) {
      try {
        await opts.exec(source.flag);
        return;
      } catch (err) {
        if (opts.signal.aborted) throw err; // pause/stop — propagate as-is
        lastErr = err;
        if (attempt < attempts) {
          opts.onProgress?.(`${opts.label} 网络波动，重试中（${attempt}/${attempts - 1}）...`);
        }
      }
    }
    opts.onProgress?.(`${opts.label} ${source.label}失败，换下一个 npm 源...`);
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${opts.label}失败：${detail}`);
}

// ─── pip index fallback (docling preload CN-timeout regression) ─────────────
//
// Error-driven (2026-07): docling 预下载在国内机器上失败——pip 先试清华镜像，一旦
// 该镜像临时抖动，旧代码直接退回 pip 的**默认源**（pypi.org / files.pythonhosted.org）
// 且用 pip 默认 15s connect timeout、不重试；而默认源在国内经常连不上 →
// ConnectTimeoutError(connect timeout=15) → 整个预下载失败。修复：和 remotion 的 npm
// 走同一套「同源重试 + 跨源降级」防御（runPipInstallWithFallback），先试多个国内镜像
// （它们也托管 wheel 文件，故镜像可用时 pip 根本不碰 files.pythonhosted.org），官方源
// 兜底；每次都用宽松的 --timeout，避免慢但活着的源被 15s 误杀。

/** Per-connection socket timeout (seconds) passed to pip via `--timeout`. pip
 *  forwards this to `requests` as a single value applied to BOTH connect and
 *  read, so it also raises the connect timeout — pip's default 15s was exactly
 *  the `connect timeout=15` seen in the 2026-07 CN failure. 60s tolerates a
 *  slow-but-alive mirror without making a truly-dead host wait forever. */
export const PIP_CONNECT_TIMEOUT_SECS = 60;

/** Ordered PyPI indices to try for the docling install. CN mirrors first — they
 *  host the wheel files too, so while any mirror works pip never touches the
 *  CN-blocked files.pythonhosted.org; the official index last as the
 *  always-complete sync source. Each is retried `attemptsPerIndex` times for
 *  transient blips before switching (see runPipInstallWithFallback). `args` is
 *  the `-i <url>` fragment (empty = pip's own default index). */
export const PIP_INDEX_FALLBACKS: ReadonlyArray<{ label: string; args: string[] }> = [
  { label: '清华源', args: ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'] },
  { label: '阿里云源', args: ['-i', 'https://mirrors.aliyun.com/pypi/simple'] },
  { label: '中科大源', args: ['-i', 'https://pypi.mirrors.ustc.edu.cn/simple'] },
  { label: '官方源', args: [] },
];

/** Build the `pip install docling` argv for one index attempt: the index
 *  fragment (if any) plus a generous `--timeout` so connect/read aren't killed
 *  at pip's 15s default. Pure + exported for tests. */
export function doclingPipInstallArgv(venvPy: string, indexArgs: string[]): string[] {
  return [
    venvPy, '-m', 'pip', 'install', 'docling',
    ...indexArgs,
    '--timeout', String(PIP_CONNECT_TIMEOUT_SECS),
  ];
}

export interface PipFallbackOpts {
  /** Step name shown in progress + final error. */
  label: string;
  signal: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Run one `pip install docling` attempt for a given index argv fragment (the
   *  `-i <url>` pair, or [] for pip's default index). Rejects on non-zero exit
   *  / timeout. */
  exec: (indexArgs: string[]) => Promise<void>;
  /** Transient retries per index before switching. Default 2. */
  attemptsPerIndex?: number;
}

/**
 * Run the docling pip install with transient retry per index AND fallback ACROSS
 * indices (see PIP_INDEX_FALLBACKS). Mirrors runWithRegistryFallback: same-index
 * retries cover a single dropped wheel / network blip; cross-index fallback
 * covers a mirror that's down or lagging. Succeeds as soon as any attempt
 * succeeds; throws only when every index is exhausted, with the label + last
 * error so the UI/log pinpoints the failure. Pause/stop (signal.aborted) aborts
 * immediately with the original error — never retried, never switched.
 */
export async function runPipInstallWithFallback(opts: PipFallbackOpts): Promise<void> {
  if (opts.signal.aborted) throw new Error('aborted');
  const attempts = opts.attemptsPerIndex ?? 2;
  let lastErr: unknown = null;
  for (const source of PIP_INDEX_FALLBACKS) {
    for (let attempt = 1; attempt <= attempts && !opts.signal.aborted; attempt++) {
      try {
        await opts.exec(source.args);
        return;
      } catch (err) {
        if (opts.signal.aborted) throw err; // pause/stop — propagate as-is
        lastErr = err;
        if (attempt < attempts) {
          opts.onProgress?.(`${opts.label} 网络波动，重试中（${attempt}/${attempts - 1}）...`);
        }
      }
    }
    opts.onProgress?.(`${opts.label} ${source.label}失败，换下一个 pip 源...`);
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${opts.label}失败：${detail}`);
}

/**
 * Decide which skills a /start request should (re)launch vs treat as
 * already-installed. A skill needs (re)starting when it is `missing` (fresh),
 * `paused` (resume), OR `failed` (retry a failed download). `failed` was absent
 * from this decision originally, so the error toast's 重试 button became a
 * silent no-op: the route treated the failed skill as "already done", emitted a
 * fake completion, and the toast just vanished without re-downloading.
 * `downloaded`/`installed`/`dismissed`/`preloading`/`unchecked` are treated as
 * done so we neither reinstall nor double-start. Pure + exported for tests.
 */
export function skillsNeedingStart(
  statusOf: (sk: PreloadableSkill) => SkillStatus,
  skills: PreloadableSkill[],
): { needsStart: PreloadableSkill[]; alreadyDone: PreloadableSkill[] } {
  const needsStart: PreloadableSkill[] = [];
  const alreadyDone: PreloadableSkill[] = [];
  for (const sk of skills) {
    const st = statusOf(sk).status;
    if (st === 'missing' || st === 'paused' || st === 'failed') needsStart.push(sk);
    else alreadyDone.push(sk);
  }
  return { needsStart, alreadyDone };
}

// ─── Path helpers (venv layout, cross-platform) ─────────────────────────────

function venvRoot(): string {
  return path.join(os.homedir(), '.molio', 'venv');
}
function venvBinaryDir(): string {
  return process.platform === 'win32'
    ? path.join(venvRoot(), 'Scripts')
    : path.join(venvRoot(), 'bin');
}
function venvPythonPath(): string {
  return process.platform === 'win32'
    ? path.join(venvBinaryDir(), 'python.exe')
    : path.join(venvBinaryDir(), 'python');
}
function venvPipPath(): string {
  return process.platform === 'win32'
    ? path.join(venvBinaryDir(), 'pip.exe')
    : path.join(venvBinaryDir(), 'pip');
}
function doclingBinaryPath(): string {
  return process.platform === 'win32'
    ? path.join(venvBinaryDir(), 'docling.exe')
    : path.join(venvBinaryDir(), 'docling');
}

/** Whether the preload venv's docling launcher exists, using the platform-
 *  correct name (`docling.exe` on Windows, `docling` elsewhere). Shared by the
 *  post-install verification and install detection so the two can never
 *  disagree. Exported for tests.
 *
 *  Error-driven (2026-07 Windows): the post-install check used to look for the
 *  extensionless `docling`, which on Windows never matches pip's `docling.exe`
 *  → a fully successful install was reported as "未生成 docling 可执行文件".
 *  macOS was unaffected because its launcher really is extensionless. */
export function doclingVenvBinaryPresent(): boolean {
  return fs.existsSync(doclingBinaryPath());
}

/** `-c` shim that runs docling's CLI entry point in-process. Used on Windows so
 *  the model-warmup step spawns `python` directly (hidden via windowsHide)
 *  instead of the `docling.exe` launcher — which would otherwise re-spawn
 *  python as a console-windowed grandchild (the launcher is a console app).
 *  docling.cli.main:app is the published console_scripts target, so this is
 *  exactly what the launcher invokes. Trailing CLI args are passed as argv
 *  after `-c` (click/typer read sys.argv[1:]), so paths never need embedding. */
export const DOCLING_CLI_SHIM =
  'import sys; from docling.cli.main import app; sys.exit(app() or 0)';

/** A minimal valid 1-page PDF (base64), used ONLY to trigger docling's
 *  StandardPdfPipeline during model warmup. A markdown/empty input routes to
 *  SimplePipeline and never loads the layout/table AI models (verified
 *  2026-07); a PDF forces the standard pipeline, which downloads the models at
 *  init time. The PDF content is irrelevant — we discard the conversion output
 *  and only want the side effect of populating the model cache. */
export const DOCLING_WARMUP_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAod2FybXVwKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMyOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjM5OAolJUVPRgo=';

/** Build the model-warmup argv. `inputPath` must be a real PDF (the caller
 *  decodes DOCLING_WARMUP_PDF_B64) — markdown/empty input routes to
 *  SimplePipeline and never loads the layout/table AI models (verified
 *  2026-07), whereas a PDF forces StandardPdfPipeline, which downloads the
 *  models at init. `--from pdf` pins the format. The conversion itself may
 *  still exit non-zero (e.g. a model the HF mirror lacks) — that's fine, the
 *  cache is populated at init and the caller treats warmup failure as
 *  non-fatal. Windows runs docling via `python -c <shim>` (in-process, no
 *  launcher → no console grandchild); POSIX keeps the real launcher. Exported
 *  for tests. */
export function doclingWarmupArgv(
  isWin: boolean,
  venvPy: string,
  inputPath: string,
  outDir: string,
): string[] {
  return isWin
    ? [venvPy, '-c', DOCLING_CLI_SHIM, inputPath, '--from', 'pdf', '--to', 'md', '--output', outDir]
    : [doclingBinaryPath(), inputPath, '--from', 'pdf', '--to', 'md', '--output', outDir];
}
function remotionPreloadMarker(): string {
  return path.join(os.homedir(), '.molio', '.remotion-preloaded');
}

/**
 * Delete a skill's partial preload artifacts — used by "stop" so the skill
 * returns to a clean `missing` state. The npm cache (~/.npm) is intentionally
 * NOT touched (shared across the whole pnpm/npm environment; deleting it would
 * slow everything else down). Mirrors the cleanup in docs/preload-cleanup.md.
 */
function deletePartial(skill: PreloadableSkill): void {
  try {
    if (skill === 'docling') {
      // The venv holds the partial pip install (packages + PyTorch).
      fs.rmSync(venvRoot(), { recursive: true, force: true });
      // Half-downloaded HuggingFace models live here. Only remove docling's
      // model dirs (models--docling-project--*), not other tools' models.
      const hub = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
      if (fs.existsSync(hub)) {
        for (const entry of fs.readdirSync(hub)) {
          if (entry.startsWith('models--docling-project--')) {
            fs.rmSync(path.join(hub, entry), { recursive: true, force: true });
          }
        }
      }
    } else if (skill === 'remotion') {
      // Marker is the only remotion-specific artifact; npm cache is shared.
      fs.rmSync(remotionPreloadMarker(), { force: true });
    }
  } catch {
    // best-effort — partial deletion failure shouldn't block the stop flow
  }
}

/** Parse `Python 3.12.1` → [3, 12]; null if it doesn't look like CPython. */
function parsePyVersion(out: string): [number, number] | null {
  const m = out.match(/Python\s+(\d+)\.(\d+)/);
  if (!m || !m[1] || !m[2]) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Version of an already-resolved ABSOLUTE python executable. Uses execFileSync
 *  (no shell) so paths with spaces (common in Windows usernames) are safe. */
function versionOfAbs(exe: string): [number, number] | null {
  try {
    const out = execFileSync(exe, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      windowsHide: true,
    });
    return parsePyVersion(out);
  } catch {
    return null;
  }
}

/**
 * Resolve a python "probe" — a bare name, an absolute path, or a `py -3.X`
 * launcher invocation — to an ABSOLUTE executable path (or null). Returning an
 * absolute path lets every downstream call site use runArgv (no shell, so
 * spaces are a non-issue) and quote uniformly. Cross-platform:
 *   - Win `py[-3.X]` → ask the launcher for sys.executable
 *   - Win otherwise    → `where "<probe>"` (where.exe; PATHEXT resolves .exe)
 *   - POSIX            → `command -v '<probe>'` (shell builtin, needs a shell)
 */
function resolveToAbs(probe: string): string | null {
  try {
    if (process.platform === 'win32') {
      if (/^py(\.exe)?(\s|$)/.test(probe)) {
        const out = execSync(`${probe} -c "import sys;print(sys.executable)"`, {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true,
        }).trim();
        return out.split(/\r?\n/)[0]?.trim() || null;
      }
      const out = execSync(`where ${q(probe)}`, {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true,
      }).trim();
      return out.split(/\r?\n/)[0]?.trim() || null;
    }
    const out = execSync(`command -v ${q(probe)}`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true,
    }).trim();
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

const cmpVer = (a: [number, number], b: [number, number]) =>
  a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];

/**
 * Ordered python probes for this platform — every realistic place a 3.10+
 * could live, NOT just whatever happens to be on the daemon's PATH:
 *  Win: `py -3.X` launcher (the reliable versioned selector), versioned
 *       aliases, python.org / MS-Store / conda install dirs, uv-managed.
 *  POSIX: versioned names, Homebrew + /usr/local + /usr/bin, conda, uv.
 * This is what makes "need 3.10+" accurate on Windows (earlier we only tried
 * bare `python3.12` + a trailing `py`, missing `py -3.12` and install dirs, so
 * a Win box with 3.12 installed but a 3.9 default got a false "need 3.10+").
 */
function buildPyProbes(): string[] {
  const vers = ['3.13', '3.12', '3.11', '3.10'];
  const probes: string[] = [];
  const env = process.env;
  if (process.platform === 'win32') {
    for (const v of vers) probes.push(`py -${v}`);
    for (const v of vers) probes.push(`python${v}`);
    const LA = env['LOCALAPPDATA'], PF = env['ProgramFiles'], PF86 = env['ProgramFiles(x86)'];
    const PD = env['ProgramData'], UP = env['USERPROFILE'], AR = env['APPDATA'];
    const dirs: string[] = [];
    for (const v of vers) {
      const d = v.replace('.', '');
      if (LA) dirs.push(`${LA}\\Programs\\Python\\Python${d}\\python.exe`);
      dirs.push(`C:\\Python${d}\\python.exe`);
      if (PF) dirs.push(`${PF}\\Python${d}\\python.exe`);
      if (PF86) dirs.push(`${PF86}\\Python${d}\\python.exe`);
    }
    if (PD) dirs.push(`${PD}\\anaconda3\\python.exe`, `${PD}\\miniconda3\\python.exe`, `${PD}\\miniforge3\\python.exe`);
    if (UP) dirs.push(`${UP}\\anaconda3\\python.exe`, `${UP}\\miniconda3\\python.exe`, `${UP}\\miniforge3\\python.exe`);
    if (AR) dirs.push(`${AR}\\anaconda3\\python.exe`, `${AR}\\miniconda3\\python.exe`);
    probes.push(...dirs);
    for (const v of vers) {
      try {
        const p = execSync(`uv python find ${v}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim();
        if (p) probes.push(p);
      } catch { /* no uv / no such version */ }
    }
    probes.push('python', 'py', 'python3');
  } else {
    for (const v of vers) probes.push(`python${v}`);
    for (const v of vers) probes.push(`/opt/homebrew/bin/python${v}`, `/usr/local/bin/python${v}`, `/usr/bin/python${v}`);
    const conda = ['/opt/anaconda3/bin/python3', '/opt/miniconda3/bin/python3', '/opt/miniforge3/bin/python3'];
    if (env['HOME']) conda.push(`${env['HOME']}/anaconda3/bin/python3`, `${env['HOME']}/miniconda3/bin/python3`, `${env['HOME']}/miniforge3/bin/python3`);
    probes.push(...conda);
    for (const v of vers) {
      try {
        const p = execSync(`uv python find ${v}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim();
        if (p) probes.push(p);
      } catch { /* no uv / no such version */ }
    }
    probes.push('python3', 'python');
  }
  return probes;
}

/**
 * Find a Python >= (minMajor.minMinor), returning its ABSOLUTE path so callers
 * can runArgv it without shell/quoting concerns. docling needs >=3.10; on a box
 * whose only `python3` is 3.9, a naive pick builds a 3.9 venv where docling's
 * `pyobjc-core` fails to compile on modern clang — a cryptic error we now avoid
 * by hunting for a real 3.10+ and otherwise failing loudly with guidance.
 * Returns the highest version seen when nothing qualifies, for diagnostics.
 */
function findPythonAtLeast(
  minMajor: number,
  minMinor: number,
): { bin: string; version: [number, number] } | { bin: null; version: [number, number] | null } {
  let best: { bin: string; version: [number, number] } | null = null;
  for (const probe of buildPyProbes()) {
    const exe = resolveToAbs(probe);
    if (!exe) continue;
    const ver = versionOfAbs(exe);
    if (!ver) continue;
    if (!best || cmpVer(ver, best.version) > 0) best = { bin: exe, version: ver };
    if (ver[0] > minMajor || (ver[0] === minMajor && ver[1] >= minMinor)) {
      return { bin: exe, version: ver };
    }
  }
  return { bin: null, version: best?.version ?? null };
}

// ─── Locating an installed docling (cross-platform, cache-backed) ────────────
//
// docling can live in two places: the preload's own venv, OR a global/user
// install done by the agent / SKILL.md / a manual `pip install` / an older
// build. The global one is NOT reliably on the daemon's PATH (esp. Windows,
// where `pip install --user` lands in `%APPDATA%\Python\…\Scripts`, and conda
// envs aren't active). So detection must NOT depend on PATH alone — we also
// look in the Scripts dir of every python we can find. The result is cached
// (a locate scan does ~dozens of `where`/`command -v` execs); invalidate at
// every point install state can change so the /status API stays cheap & fresh.

let _doclingLocCache: string | null | undefined = undefined;
export function invalidateDoclingLoc(): void { _doclingLocCache = undefined; }

function findDoclingOnPath(): string | null {
  try {
    const out = process.platform === 'win32'
      ? execSync('where docling', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim()
      : execSync('command -v docling', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, windowsHide: true }).trim();
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function computeLocateDocling(): string | null {
  if (_doclingLocCache !== undefined) return _doclingLocCache;
  const venv = doclingBinaryPath();
  if (fs.existsSync(venv)) return (_doclingLocCache = venv);
  const onPath = findDoclingOnPath();
  if (onPath) return (_doclingLocCache = onPath);
  // Not on PATH: look in each known python's scripts dir (Unix: same dir as the
  // interpreter; Windows: the sibling `Scripts\`). This catches global/user/
  // conda installs the daemon's PATH can't see.
  const isWin = process.platform === 'win32';
  for (const probe of buildPyProbes()) {
    const exe = resolveToAbs(probe);
    if (!exe) continue;
    const scriptsDir = isWin ? path.join(path.dirname(exe), 'Scripts') : path.dirname(exe);
    const cand = path.join(scriptsDir, isWin ? 'docling.exe' : 'docling');
    if (fs.existsSync(cand)) return (_doclingLocCache = cand);
  }
  return (_doclingLocCache = null);
}

/** Real install locations — surfaced via /status so the UI/docs report the
 *  truth (venv vs global vs conda vs …) instead of guessing. This is the core
 *  of "兼容旧地址": the system introspects the actual path, whatever it is. */
export function getPreloadLocations(): { docling: string | null; remotion: string | null } {
  return {
    docling: computeLocateDocling(),
    remotion: fs.existsSync(remotionPreloadMarker()) ? remotionPreloadMarker() : null,
  };
}

// ─── Helper: run a child process with timeout + line callback ────────────────

type RunOpts = {
  timeout?: number;
  cwd?: string;
  signal?: AbortSignal;
  /** Extra env vars merged ON TOP of process.env for the child only — used to
   *  inject e.g. HF_ENDPOINT for the docling model warmup without polluting the
   *  daemon's own environment or the user's shell profile. */
  env?: Record<string, string>;
  onLine?: (line: string) => void;
};

/** Build the child env: inherit the daemon's env, overlay caller extras. */
function childEnv(opts: RunOpts): NodeJS.ProcessEnv | undefined {
  if (!opts.env) return undefined; // undefined → spawn inherits process.env as-is
  return { ...process.env, ...opts.env };
}

/**
 * Quote a path/argument for safe interpolation into a SHELL command string
 * (only used by runProcess + the python-locator probes). runArgv below needs
 * NO quoting because it bypasses the shell entirely — prefer runArgv whenever
 * the command is a simple executable + args, since shell quoting of paths with
 * spaces (common in Windows usernames, e.g. `C:\Users\Jane Doe\…`) is fragile
 * and was the source of cross-platform breakage.
 */
function q(p: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: wrap in double quotes; strip any embedded double quotes
    // (paths containing " are effectively nonexistent).
    return `"${p.replace(/"/g, '')}"`;
  }
  // POSIX sh: single-quote, escaping embedded single quotes.
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Shared IO/abort/close wiring for a spawned child (shell or argv form). */
function runSpawned(proc: ChildProcess, opts: RunOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    // Abort wiring: when PreloadManager aborts (pause/stop), kill the entire
    // process tree. The 'close' handler then rejects with an AbortError so
    // meta.preload propagates the interruption up to startPreload's catch.
    const onAbort = () => killProcessTree(proc);
    if (opts.signal) {
      if (opts.signal.aborted) {
        killProcessTree(proc);
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Combined output tail for the failure message. stderr alone is NOT
    // enough: CLIs like create-video print their errors to STDOUT, which made
    // failures surface as a contentless "进程退出码 1:" that told the user (and
    // us) nothing. Keep both streams' tails merged so the real error shows.
    let combinedTail = '';
    const pushCombined = (s: string) => {
      combinedTail = (combinedTail + s).slice(-300);
    };

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      pushCombined(text);
      stdoutBuf += text;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLine?.(line);
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      pushCombined(text);
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLine?.(line);
      }
    });

    proc.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const errMsg = `进程退出码 ${code}: ${combinedTail.trim()}`;
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/** Run a command THROUGH a shell (needed for `&&`/`||`/pipes, e.g. npm chains).
 *  Callers must pre-quote any interpolated paths via q(). */
/** Shared spawn options for every preload child process.
 *  - `detached` is POSIX-ONLY: it gives Unix a process group for `kill(-pid)`.
 *    On Windows, tree-kill goes through `taskkill /T` (parent→child walk) and
 *    needs NO detached — and setting detached there is actively harmful: libuv
 *    maps it to DETACHED_PROCESS, which (a) defeats `windowsHide` on the direct
 *    child and (b) makes every console-subsystem grandchild (the node/python
 *    that npm/pip launch) allocate its OWN visible console window. That
 *    combination was the 2026-07 "black windows still pop after adding
 *    windowsHide" bug.
 *  - `windowsHide:true` everywhere: hides the direct child's console on
 *    Windows; a no-op on POSIX (no per-process console window there).
 *  Exported for tests. */
export function preloadSpawnOpts(opts: RunOpts): Parameters<typeof spawn>[2] {
  return {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: childEnv(opts),
    detached: process.platform !== 'win32',
    windowsHide: true,
  };
}

function runProcess(command: string, opts: RunOpts = {}): Promise<void> {
  const useShell = process.platform !== 'win32';
  const proc = useShell
    ? spawn('sh', ['-c', command], preloadSpawnOpts(opts))
    : spawn('cmd', ['/c', command], preloadSpawnOpts(opts));
  return runSpawned(proc, opts);
}

/** Run an executable + args WITHOUT a shell — immune to spaces in paths and
 *  shell-injection. PREFERRED for python/pip/docling invocations. */
function runArgv(argv: string[], opts: RunOpts = {}): Promise<void> {
  const file = argv[0];
  if (!file) return Promise.reject(new Error('runArgv: empty argv'));
  const args = argv.slice(1);
  const proc = spawn(file, args, preloadSpawnOpts(opts));
  return runSpawned(proc, opts);
}

/**
 * Kill an entire spawned process tree. `spawn(..., {detached:true})` makes the
 * child a process-group leader on Unix, so `kill(-pid)` reaches the shell +
 * pip + any download/compile subprocess it spawned. Windows has no negative-
 * pid kill; fall back to `taskkill /T /F` which walks the tree.
 * No-op (caught) if the process already exited.
 */
function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    // already exited — nothing to kill
  }
}

// ─── PreloadManager ──────────────────────────────────────────────────────────

export class PreloadManager {
  private statuses = new Map<PreloadableSkill, SkillStatus>();
  private ee = new EventEmitter();
  private runningTasks = new Map<PreloadableSkill, AbortController>();
  /** Skills the user asked to pause — checked in startPreload's catch so an
   *  aborted run lands in 'paused' (partial kept) instead of 'failed'. */
  private pauseRequested = new Set<PreloadableSkill>();
  /** Skills the user asked to stop — checked in startPreload's catch so an
   *  aborted run lands in 'missing' with partials deleted. */
  private stopRequested = new Set<PreloadableSkill>();

  constructor() {
    for (const sk of PRELOADABLE_SKILLS) {
      this.statuses.set(sk, { status: 'unchecked' });
    }
  }

  /**
   * Check all preloadable skills and update their status.
   * Called once at daemon startup.
   */
  checkSkills(): void {
    const config = loadConfig();
    const dismissed: string[] = (config as any).preload?.dismissed ?? [];
    // Freshly resolve install locations (the cache may be stale across restarts
    // or after an out-of-band install/uninstall).
    invalidateDoclingLoc();

    for (const sk of PRELOADABLE_SKILLS) {
      if (dismissed.includes(sk)) {
        this.statuses.set(sk, { status: 'dismissed' });
        continue;
      }

      const meta = SKILL_META[sk];
      const installed = meta.detectInstalled();
      this.statuses.set(sk, installed
        ? { status: 'installed' }
        : { status: 'missing' },
      );
    }

    this.emitStatus();
  }

  /**
   * Get the current status of all skills.
   */
  getStatuses(): Record<PreloadableSkill, SkillStatus> {
    const out: Record<string, SkillStatus> = {};
    for (const sk of PRELOADABLE_SKILLS) {
      out[sk] = this.statuses.get(sk) ?? { status: 'unchecked' };
    }
    return out as Record<PreloadableSkill, SkillStatus>;
  }

  /**
   * Get the status of a single skill.
   */
  getStatus(skill: PreloadableSkill): SkillStatus {
    return this.statuses.get(skill) ?? { status: 'unchecked' };
  }

  /**
   * Start (or resume) preloading a skill in the background.
   * Resuming works because pip / HuggingFace / npm all reuse their caches —
   * a re-run skips already-downloaded packages and resumes `.incomplete`
   * model files. Throws only if already actively preloading.
   */
  async startPreload(skill: PreloadableSkill): Promise<void> {
    const current = this.statuses.get(skill);
    if (current?.status === 'preloading') {
      throw new Error(`${skill} 正在预下载中`);
    }
    // A fresh start must not inherit a stale pause/stop intent from a previous
    // run (e.g. pause→stop left pauseRequested set), else the onProgress guard
    // above would mute this run and a failure would be mislabelled 'paused'.
    this.pauseRequested.delete(skill);
    this.stopRequested.delete(skill);
    invalidateDoclingLoc(); // install state is about to change

    const ac = new AbortController();
    this.runningTasks.set(skill, ac);

    const meta = SKILL_META[skill];
    this.statuses.set(skill, { status: 'preloading', progress: 0, message: '准备中...' });
    this.emitStatus();
    this.emitProgress({ skill, status: 'preloading', progress: 0, message: '准备中...' });

    try {
      await meta.preload((pct, msg) => {
        // If the user paused/stopped mid-run, stop updating progress — the
        // catch block below sets the terminal status.
        if (this.pauseRequested.has(skill) || this.stopRequested.has(skill)) return;
        this.statuses.set(skill, { status: 'preloading', progress: pct, message: msg });
        this.emitStatus();
        this.emitProgress({ skill, status: 'preloading', progress: pct, message: msg });
      }, ac.signal);

      this.statuses.set(skill, { status: 'downloaded' });
      this.emitStatus();
      this.emitProgress({ skill, status: 'completed', progress: 100, message: `${skill} 预下载完成` });
    } catch (err) {
      // Distinguish a user-initiated pause/stop from a real failure. The
      // intent set was populated by pausePreload/stopPreload BEFORE aborting;
      // the abort propagates here as a rejection, and we resolve into the
      // user's chosen terminal state instead of marking it failed.
      if (this.stopRequested.has(skill)) {
        this.stopRequested.delete(skill);
        this.pauseRequested.delete(skill); // stop supersedes any pending pause
        // kill already happened via abort; now drop partial artifacts.
        deletePartial(skill);
        this.statuses.set(skill, { status: 'missing' });
        this.emitStatus();
        this.emitProgress({ skill, status: 'stopped', progress: 0, message: `${skill} 已停止` });
      } else if (this.pauseRequested.has(skill)) {
        this.pauseRequested.delete(skill);
        // Keep partials on disk — resume reuses them.
        this.statuses.set(skill, { status: 'paused' });
        this.emitStatus();
        this.emitProgress({ skill, status: 'paused', progress: 0, message: `${skill} 已暂停` });
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.statuses.set(skill, { status: 'failed', error: errMsg });
        this.emitStatus();
        this.emitProgress({ skill, status: 'failed', progress: 0, message: errMsg });
      }
    } finally {
      this.runningTasks.delete(skill);
      invalidateDoclingLoc(); // reflect newly installed/removed binary in /status
    }
  }

  /**
   * Pause an in-progress preload: abort the running process tree but KEEP
   * partial artifacts (venv, downloaded packages, `.incomplete` models) so
   * resume picks up where it left off. No-op if not currently preloading.
   * `paused` is a memory-only state — on daemon restart the skill shows as
   * `missing` again (partials still on disk, so resume still works).
   */
  pausePreload(skill: PreloadableSkill): void {
    this.pauseRequested.add(skill);
    this.runningTasks.get(skill)?.abort();
  }

  /**
   * Stop a preload: abort the running process AND delete partial artifacts
   * so the skill is fully clean. Works on a running OR a paused skill
   * (paused skill has no live task, so we clean up directly here).
   */
  stopPreload(skill: PreloadableSkill): void {
    this.stopRequested.add(skill);
    const ac = this.runningTasks.get(skill);
    if (ac) {
      // Running — abort; startPreload's catch will delete partials + set missing.
      ac.abort();
    } else {
      // Not running (paused/failed/missing) — clean up directly here, since
      // there's no live startPreload to catch the intent.
      this.stopRequested.delete(skill);
      this.pauseRequested.delete(skill); // stop = full reset, drop pending pause too
      deletePartial(skill);
      this.statuses.set(skill, { status: 'missing' });
      invalidateDoclingLoc();
      this.emitStatus();
      this.emitProgress({ skill, status: 'stopped', progress: 0, message: `${skill} 已停止` });
    }
  }

  /** Test-only: whether a pause intent is lingering for `skill`. A lingering
   *  intent after a stop would mute a subsequent run's progress and mislabel
   *  its failure as 'paused' (the 2026-07 pause→stop latent bug). */
  _testHasPauseIntent(skill: PreloadableSkill): boolean {
    return this.pauseRequested.has(skill);
  }

  /** Stop all running preloads. Called on daemon graceful shutdown so we
   *  don't orphan detached child processes (pip/npm keep running otherwise). */
  stopAll(): void {
    for (const skill of this.runningTasks.keys()) {
      this.stopPreload(skill);
    }
  }

  /**
   * Dismiss a skill — don't prompt the user about it again.
   * Persisted to config.json.
   */
  dismissSkill(skill: PreloadableSkill): void {
    this.statuses.set(skill, { status: 'dismissed' });
    invalidateDoclingLoc();
    this.emitStatus();

    // Persist to config
    try {
      const config = loadConfig();
      const preload: { dismissed: string[] } = (config as any).preload ?? { dismissed: [] };
      if (!preload.dismissed.includes(skill)) {
        preload.dismissed.push(skill);
      }
      saveConfig(mergeConfig({ ...config, preload } as any));
    } catch {
      // Best-effort
    }
  }

  /** Reset a dismissed skill so it shows as missing again (for settings page). */
  undismissSkill(skill: PreloadableSkill): void {
    const config = loadConfig();
    const preload: { dismissed: string[] } = (config as any).preload ?? { dismissed: [] };
    preload.dismissed = preload.dismissed.filter((s: string) => s !== skill);
    try {
      saveConfig(mergeConfig({ ...config, preload } as any));
    } catch { /* best-effort */ }

    // Re-check
    invalidateDoclingLoc();
    const meta = SKILL_META[skill];
    const installed = meta.detectInstalled();
    this.statuses.set(skill, installed
      ? { status: 'installed' }
      : { status: 'missing' },
    );
    this.emitStatus();
  }

  // ─── Event helpers ─────────────────────────────────────────────────────

  onProgress(cb: (event: PreloadProgressEvent) => void): () => void {
    this.ee.on('progress', cb);
    return () => { this.ee.off('progress', cb); };
  }

  onStatusChange(cb: () => void): () => void {
    this.ee.on('status', cb);
    return () => { this.ee.off('status', cb); };
  }

  private emitProgress(event: PreloadProgressEvent): void {
    this.ee.emit('progress', event);
  }

  private emitStatus(): void {
    this.ee.emit('status');
  }
}

export function createPreloadManager(): PreloadManager {
  return new PreloadManager();
}
