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

import { spawn, execSync, type ChildProcess } from 'node:child_process';
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
      // 1. The Molio venv is the primary install location (created by
      //    preload). Checking the binary directly is PATH-independent and
      //    works even when the daemon itself wasn't launched from a login
      //    shell (so ~/.molio/venv/bin isn't on the daemon's own PATH).
      if (fs.existsSync(doclingBinaryPath())) return true;

      // 2. Fall back to PATH lookup — covers systems where the user
      //    installed docling globally themselves before Molio.
      try {
        execSync('docling --version', {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 10_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    async preload(onProgress, signal) {
      const venvBin = venvBinaryDir();
      const venvPy = venvPythonPath();
      const venvPip = venvPipPath();

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
            ? '从 python.org 下载 3.12 安装包，或用 winget install Python.Python.3.12'
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
      onProgress(5, `准备 Python ${pyInfo.version[0]}.${pyInfo.version[1]} 隔离环境...`);
      const venvVer = fs.existsSync(venvPy) ? probePyVersion(venvPy) : null;
      const venvStale = !venvVer || venvVer[0] < 3 || (venvVer[0] === 3 && venvVer[1] < 10);
      if (fs.existsSync(venvRoot()) && venvStale) {
        onProgress(6, '旧 Python 环境版本过低，重建中...');
        fs.rmSync(venvRoot(), { recursive: true, force: true });
      }
      if (!fs.existsSync(venvPy)) {
        onProgress(8, '创建隔离 Python 环境...');
        await runProcess(`${pyInfo.bin} -m venv ${venvRoot()}`, { timeout: 60_000, signal });
        if (!fs.existsSync(venvPy)) {
          throw new Error('无法创建 Python venv，请确认 Python 3.10+ 安装完整');
        }
      }

      // Phase 2: pip install docling (8 → 55). Surface the REAL pip error so a
      // future failure is diagnosable (earlier the build error was swallowed
      // and only a generic hint showed).
      const mirror = '-i https://pypi.tuna.tsinghua.edu.cn/simple';
      onProgress(12, '正在安装 docling Python 包（含 PyTorch）...');
      let pipOk = false;
      let lastPipErr = '';
      try {
        await runProcess(`${venvPip} install docling ${mirror}`, {
          timeout: 600_000,
          signal,
          onLine(line) {
            if (line.includes('Downloading') || line.includes('Installing collected packages')) {
              onProgress(20, line.trim());
            }
          },
        });
        pipOk = true;
      } catch (err) {
        if (signal.aborted) throw err; // pause/stop — don't fall through to retry
        lastPipErr = err instanceof Error ? err.message : String(err);
        // Fallback: default index (mirror may be down or package missing there)
        onProgress(40, '镜像失败，尝试默认源...');
        try {
          await runProcess(`${venvPip} install docling`, {
            timeout: 600_000,
            signal,
            onLine(line) {
              if (line.includes('Downloading') || line.includes('Installing collected packages')) {
                onProgress(45, line.trim());
              }
            },
          });
          pipOk = true;
        } catch (err2) {
          if (signal.aborted) throw err2;
          lastPipErr = err2 instanceof Error ? err2.message : String(err2);
          pipOk = false;
        }
      }
      if (!pipOk || !fs.existsSync(path.join(venvBin, 'docling'))) {
        const detail = lastPipErr ? `（${lastPipErr.slice(0, 240)}）` : '（未生成 docling 可执行文件）';
        throw new Error(`docling 安装失败${detail}。可手动运行：${venvPip} install docling`);
      }

      // Phase 3: Model warmup (55 → 100). Run a no-op conversion so docling
      // downloads its layout + table models into ~/.cache/huggingface now,
      // not on the user's first real conversion. Failure here is non-fatal —
      // the models will download on first real use.
      onProgress(60, '下载 AI 模型（layout + table，~500MB）...');
      try {
        const discard = process.platform === 'win32' ? 'NUL' : '/dev/null';
        const outDir = path.join(os.tmpdir(), 'molio-docling-preload');
        await runProcess(`${doclingBinaryPath()} ${discard} --to md --output ${outDir} 2>&1`, {
          timeout: 600_000,
          signal,
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
      // Remotion's first real use is `npx create-video` inside the vault's
      // .molio/remotion/, which runs `npm install` for ~100MB of deps. We
      // can't reuse a skeleton project (the agent builds its own in the
      // vault), so the only thing that carries over is the **npm cache**
      // (~/.npm). We warm it by installing the core remotion packages into a
      // throwaway temp dir, then delete the dir — leaving only the cache.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-remotion-warmup-'));

      try {
        onProgress(10, '创建临时预热目录...');
        // Minimal package.json so `npm install` knows what to resolve.
        fs.writeFileSync(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({
            name: 'molio-remotion-warmup',
            private: true,
            dependencies: {
              remotion: '*',
              '@remotion/cli': '*',
              '@remotion/bundler': '*',
              '@remotion/renderer': '*',
            },
          }, null, 2),
        );

        onProgress(25, '下载 Remotion npm 依赖（首次 ~100MB）...');
        // Retry on transient registry failures — the user's npm registry is
        // often the official npmjs.org (slow/flaky from some regions), and a
        // single failed tarball fetch makes `npm install` exit 1. Verified:
        // the exact same command succeeds on retry / under better network.
        // `--prefer-offline` (not --prefer-online): this is a cache-warming
        // preload — reuse already-fetched tarballs and only fetch missing
        // ones, instead of forcing every package back through the registry.
        let npmOk = false;
        for (let attempt = 1; attempt <= 2 && !signal.aborted; attempt++) {
          try {
            await runProcess(`npm install --prefer-offline --no-audit --no-fund`, {
              timeout: 600_000,
              cwd: tmpDir,
              signal,
              onLine(line) {
                if (line.includes('added') || line.toLowerCase().includes('remov')) {
                  onProgress(60, line.trim());
                }
              },
            });
            npmOk = true;
            break;
          } catch (err) {
            if (signal.aborted) throw err; // pause/stop propagates
            if (attempt < 2) {
              onProgress(30, '网络波动，重试中...');
            } else {
              throw err;
            }
          }
        }
        if (!npmOk) {
          throw new Error('remotion npm 依赖安装失败，可稍后重试或检查网络');
        }

        // Mark as preloaded so we don't prompt again. The npm cache at
        // ~/.npm is what actually matters and persists after the temp dir
        // is deleted.
        try {
          fs.writeFileSync(remotionPreloadMarker(), new Date().toISOString());
        } catch { /* best-effort */ }

        onProgress(100, 'Remotion npm 缓存就绪');
      } finally {
        // Always clean up the throwaway project. Only the npm cache survives.
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* best-effort */ }
      }
    },
  },
};

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

/** Run `<bin> --version` and return its [major, minor], or null on any error. */
function probePyVersion(bin: string): [number, number] | null {
  try {
    const out = execSync(`${bin} --version`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return parsePyVersion(out);
  } catch {
    return null;
  }
}

const cmpVer = (a: [number, number], b: [number, number]) =>
  a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];

/**
 * Find a Python interpreter with version >= (minMajor.minMinor). docling needs
 * >=3.10; on a system whose only `python3` is 3.9 (common on older macOS), a
 * naive `python3` pick builds a 3.9 venv where docling's `pyobjc-core` fails to
 * compile from source on modern clang — a cryptic build error. We instead hunt
 * for a versioned 3.10+ binary so wheels install prebuilt.
 *
 * Search order: explicit versioned names + Homebrew opt paths (the unversioned
 * `python3` symlink is intentionally NOT on PATH after `brew install python@3.x`)
 * + uv-managed interpreters (`uv python find`) + plain python3/python/py last.
 * Returns the highest version seen when nothing qualifies, for diagnostics.
 */
function findPythonAtLeast(
  minMajor: number,
  minMinor: number,
): { bin: string; version: [number, number] } | { bin: null; version: [number, number] | null } {
  const versions = ['3.13', '3.12', '3.11', '3.10'];
  const candidates: string[] = [];
  for (const v of versions) candidates.push(`python${v}`);
  // Homebrew keeps versioned binaries on PATH but not the bare `python3`.
  if (process.platform !== 'win32') {
    for (const v of versions) {
      candidates.push(`/opt/homebrew/bin/python${v}`, `/usr/local/bin/python${v}`);
    }
  }
  // uv-managed interpreters aren't on PATH; ask uv directly (no-op if uv absent).
  for (const v of versions) {
    try {
      const p = execSync(`uv python find ${v}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      if (p) candidates.push(p);
    } catch { /* uv not installed or no such version */ }
  }
  candidates.push(...(process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']));

  let best: { bin: string; version: [number, number] } | null = null;
  for (const bin of candidates) {
    const ver = probePyVersion(bin);
    if (!ver) continue;
    if (!best || cmpVer(ver, best.version) > 0) best = { bin, version: ver };
    if (ver[0] > minMajor || (ver[0] === minMajor && ver[1] >= minMinor)) {
      return { bin, version: ver };
    }
  }
  return { bin: null, version: best?.version ?? null };
}

// ─── Helper: run a child process with timeout + line callback ────────────────

function runProcess(
  command: string,
  opts: { timeout?: number; cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform !== 'win32';
    // detached:true puts the child in its own process group (Unix) / session
    // so that on pause/stop we can kill the WHOLE tree (sh + pip + download
    // subprocesses), not just the shell wrapper. Without it, killing `sh`
    // would orphan `pip` / the in-flight download to keep running.
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout,
      cwd: opts.cwd,
      detached: true,
    };
    const proc = useShell
      ? spawn('sh', ['-c', command], spawnOpts)
      : spawn('cmd', ['/c', command], spawnOpts);

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

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        opts.onLine?.(line);
      }
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
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
        const errMsg = `进程退出码 ${code}: ${stderrBuf.slice(-200)}`;
        reject(new Error(errMsg));
      }
    });

    proc.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
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
      deletePartial(skill);
      this.statuses.set(skill, { status: 'missing' });
      this.emitStatus();
      this.emitProgress({ skill, status: 'stopped', progress: 0, message: `${skill} 已停止` });
    }
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
