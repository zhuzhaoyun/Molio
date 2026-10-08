import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdirSync, existsSync, chmodSync, writeFileSync, renameSync, unlinkSync,
  statSync, readFileSync, appendFileSync, rmSync,
} from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import type {
  InstallEvent, InstallPhase, ErrorCategory,
  NpmNativeInstallSource, ScriptInstallSource, RuntimeAgentDef,
} from '@molio/contracts';
import { validateBinary, resolveAgentBinary, needsShellOnWindows } from './launch.js';
import { getAgentDef } from './registry.js';
import { NPMMIRROR_BASE } from '../python-provision.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** User-level binary directory — where Molio installs agent CLIs. */
export function getMolioBinDir(): string {
  return path.join(os.homedir(), '.molio', 'bin');
}

// ─── Install Options ───────────────────────────────────────────────────────

export interface InstallOptions {
  agentId: string;
  onEvent: (event: InstallEvent) => void;
  /** Optional abort signal — when aborted, install stops at the next checkpoint. */
  signal?: AbortSignal;
  /**
   * @internal Test seam — injected side effects for the `script` strategy.
   * Never set by production callers (routes use plain { agentId, onEvent, signal }).
   */
  _deps?: ScriptInstallDeps;
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Install an agent CLI. Reads install configuration from the agent definition
 * (data-driven) and dispatches to the appropriate install strategy.
 *
 * Currently supported strategies:
 * - `npm-native`: downloads pre-built native binaries from npm registry
 * - `script`: downloads and runs an official installer script non-interactively
 */
export async function installAgent(opts: InstallOptions): Promise<void> {
  const { agentId, onEvent, signal } = opts;

  // 1. Resolve agent definition with install config
  const def = getAgentDef(agentId);
  if (!def?.install) {
    onEvent({
      type: 'error',
      message: `No install configuration found for agent: ${agentId}`,
      category: 'unknown',
      retryable: false,
      hint: `This agent does not support automatic installation. ` +
        `Visit ${def?.installUrl ?? 'the project website'} for manual install instructions.`,
    });
    return;
  }

  const { source } = def.install;

  // 2. Dispatch by source type
  if (source.type === 'npm-native') {
    await installFromNpmNative(def, source, onEvent, signal);
  } else if (source.type === 'script') {
    await installFromScript(def, source, onEvent, signal, opts._deps);
  } else {
    onEvent({
      type: 'error',
      message: `Unknown install source type: ${(source as any).type}`,
      category: 'unknown',
      retryable: false,
    });
  }
}

// ─── npm-native Install Strategy ───────────────────────────────────────────

async function installFromNpmNative(
  def: RuntimeAgentDef,
  source: NpmNativeInstallSource,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const agentName = def.name;
  const binName = def.install?.binName ?? def.bin;

  // ── Phase 1: Preflight ──
  onEvent({ type: 'phase', phase: 'preflight', message: 'Checking system environment...' });

  const platformKey = getPlatformKey();
  onEvent({ type: 'log', message: `Platform: ${platformKey}` });

  // Check platform allowlist
  if (def.install?.requirements?.supportedPlatforms?.length) {
    const allowed = def.install.requirements.supportedPlatforms;
    if (!allowed.includes(platformKey)) {
      onEvent({
        type: 'error',
        message: `Unsupported platform: ${platformKey}`,
        category: 'platform',
        retryable: false,
        hint: `Supported platforms: ${allowed.join(', ')}. ` +
          `${agentName} does not provide a pre-built binary for your system.`,
      });
      return;
    }
  }

  // Check Windows version
  if (process.platform === 'win32' && def.install?.requirements?.minWindowsBuild) {
    const minBuild = def.install.requirements.minWindowsBuild;
    const build = getWindowsBuildNumber();
    if (build !== null && build < minBuild) {
      onEvent({
        type: 'error',
        message: `Windows version too old (build ${build}). ` +
          `${agentName} requires Windows 10 version 1809 (build ${minBuild}) or later.`,
        category: 'platform',
        retryable: false,
        hint: `Please update your Windows version, or install ${agentName} manually: ${def.installUrl ?? ''}`,
      });
      return;
    }
  }

  // Check platform package availability
  const nativeInfo = source.packages[platformKey];
  if (!nativeInfo) {
    onEvent({
      type: 'error',
      message: `No pre-built binary available for platform: ${platformKey}`,
      category: 'platform',
      retryable: false,
      hint: `Supported platforms: ${Object.keys(source.packages).join(', ')}`,
    });
    return;
  }

  // Abort checkpoint
  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }

  // Determine target path.
  // Bundled layout (agents whose binary needs sibling resource files, e.g.
  // Codex) installs into its own directory ~/.molio/bin/<agentId>/... ;
  // single-binary agents drop straight into ~/.molio/bin/.
  const binDir = getMolioBinDir();
  const bundled = !!nativeInfo.extractDir;
  const installRoot = bundled ? path.join(binDir, def.id) : binDir;

  let targetPath: string;   // final location of the main binary
  let stagingPath: string;  // where the main binary is written before swap
  let stagingDir: string | null = null; // bundled: staging tree, swapped in last

  if (bundled) {
    const prefix = normalizeExtractDir(nativeInfo.extractDir!);
    if (!nativeInfo.binInTar.startsWith(prefix)) {
      onEvent({
        type: 'error',
        message: `Install config error: binInTar "${nativeInfo.binInTar}" ` +
          `is not inside extractDir "${prefix}"`,
        category: 'unknown',
        retryable: false,
      });
      return;
    }
    const relMain = nativeInfo.binInTar.slice(prefix.length);
    targetPath = path.join(installRoot, ...relMain.split('/'));
    stagingDir = `${installRoot}.staging`;
    stagingPath = path.join(stagingDir, ...relMain.split('/'));
  } else {
    const finalBinName = process.platform === 'win32' && !binName.endsWith('.exe')
      ? `${binName}.exe` : binName;
    targetPath = path.join(installRoot, finalBinName);
    stagingPath = targetPath + '.tmp';
  }

  mkdirSync(binDir, { recursive: true });

  if (existsSync(bundled ? installRoot : targetPath)) {
    onEvent({ type: 'log', message: 'Existing installation detected, will overwrite.' });
  }

  const encodedPkg = encodeURIComponent(nativeInfo.pkgName);

  // ── Phase 2: Version resolution ('latest' → registry dist-tags.latest) ──
  let version = source.version;
  if (version === 'latest') {
    onEvent({ type: 'phase', phase: 'download', message: 'Resolving latest version...' });
    const resolved = await resolveLatestVersion(encodedPkg, source.registries, onEvent, signal);
    if (signal?.aborted) {
      onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
      return;
    }
    if (resolved) {
      version = resolved;
      onEvent({ type: 'log', message: `Latest version resolved: ${version}` });
    } else if (source.fallbackVersion) {
      version = source.fallbackVersion;
      onEvent({
        type: 'log',
        message: `Could not resolve latest version; falling back to known-good v${version}`,
      });
    } else {
      onEvent({
        type: 'error',
        message: `Failed to resolve latest version for ${agentName}`,
        category: 'network',
        retryable: true,
        hint: 'Check your network connection and try again.',
      });
      return;
    }
  }

  // ── Phase 3: Download ──
  onEvent({ type: 'phase', phase: 'download', message: `Downloading ${nativeInfo.pkgName} v${version}...` });

  const tarballName = buildTarballName(nativeInfo, version);

  let tarball: Buffer;
  try {
    tarball = await downloadWithRetry(encodedPkg, tarballName, source.registries, onEvent, signal);
  } catch (err) {
    if (signal?.aborted) {
      onEvent({ type: 'error', message: 'Installation cancelled during download', category: 'unknown', retryable: true });
      return;
    }
    onEvent({
      type: 'error',
      message: `Failed to download ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
      category: 'network',
      retryable: true,
      hint: 'Check your network connection and try again. ' +
        'If the problem persists, the package may not be available in your region.',
    });
    return;
  }

  // ── Phase 4: Extract ──
  onEvent({ type: 'phase', phase: 'extract', message: 'Extracting binary from package...' });

  // Parsed tar content — either a single binary or a full file tree.
  let extracted: { relPath: string; data: Buffer }[];
  try {
    if (bundled) {
      const files = extractTreeFromTarball(tarball, nativeInfo.extractDir!);
      if (!files || files.length === 0) {
        onEvent({
          type: 'error',
          message: `No files found under "${nativeInfo.extractDir}" in the downloaded package.`,
          category: 'extraction',
          retryable: false,
          hint: `The package structure may have changed. Try installing ${agentName} manually: ${def.installUrl ?? ''}`,
        });
        return;
      }
      extracted = files;
    } else {
      const binary = extractFromTarball(tarball, nativeInfo.binInTar);
      if (!binary) {
        onEvent({
          type: 'error',
          message: `Binary "${nativeInfo.binInTar}" not found in the downloaded package.`,
          category: 'extraction',
          retryable: false,
          hint: `The package structure may have changed. Try installing ${agentName} manually: ${def.installUrl ?? ''}`,
        });
        return;
      }
      extracted = [{ relPath: '', data: binary }];
    }
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to extract package: ${err instanceof Error ? err.message : String(err)}`,
      category: 'extraction',
      retryable: true,
      hint: 'The downloaded package may be corrupted. Try again.',
    });
    return;
  }

  // Write to the staging location
  try {
    if (bundled) {
      rmSync(stagingDir!, { recursive: true, force: true });
      for (const file of extracted) {
        const dest = path.join(stagingDir!, ...file.relPath.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, file.data);
        if (process.platform !== 'win32') {
          // Every bundled file (binaries, rg, shell, sandbox helpers) must
          // be executable — they are invoked by the main binary at runtime.
          chmodSync(dest, 0o755);
        }
      }
      onEvent({ type: 'log', message: `Extracted ${extracted.length} files` });
    } else {
      writeFileSync(stagingPath, extracted[0]!.data);
      if (process.platform !== 'win32') {
        chmodSync(stagingPath, 0o755);
      }
    }
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to write binary: ${err instanceof Error ? err.message : String(err)}`,
      category: 'permission',
      retryable: false,
      hint: `Check write permissions for ${binDir}`,
    });
    return;
  }

  // ── Phase 5: Validate ──
  onEvent({ type: 'phase', phase: 'validate', message: 'Validating binary integrity...' });

  try {
    const validationError = validateBinary(stagingPath, process.platform);
    if (validationError) {
      onEvent({
        type: 'error',
        message: `Binary validation failed: ${validationError}`,
        category: 'validation',
        retryable: true,
        hint: 'The downloaded file may be corrupted. Try again.',
      });
      return;
    }
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Binary validation error: ${err instanceof Error ? err.message : String(err)}`,
      category: 'validation',
      retryable: true,
    });
    return;
  }

  // Swap staging into place (near-atomic: rm old, rename new)
  try {
    if (bundled) {
      rmSync(installRoot, { recursive: true, force: true });
      renameSync(stagingDir!, installRoot);
    } else {
      if (existsSync(targetPath)) {
        unlinkSync(targetPath);
      }
      renameSync(stagingPath, targetPath);
      if (process.platform !== 'win32') {
        chmodSync(targetPath, 0o755);
      }
    }
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to install binary: ${err instanceof Error ? err.message : String(err)}`,
      category: 'permission',
      retryable: false,
      hint: `Could not write to ${targetPath}. Check file permissions or try closing other programs that may be using it.`,
    });
    return;
  }

  // ── Phase 6: Runtime Test ──
  onEvent({ type: 'phase', phase: 'test', message: 'Running version check...' });

  let installedVersion: string | undefined;
  try {
    const fileStat = statSync(targetPath);
    onEvent({ type: 'log', message: `Binary size: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB` });

    const out = execFileSync(targetPath, def.versionArgs, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    installedVersion = out.trim().split('\n')[0] ?? undefined;
    onEvent({ type: 'log', message: `Version check passed: ${installedVersion}` });
  } catch (err: any) {
    const diag: Record<string, string> = {};
    diag['msg'] = (err?.message || String(err)).replace(/^Command failed:\s*/, '');
    diag['code'] = String(err?.code ?? 'undefined');
    diag['status'] = String(err?.status ?? 'undefined');
    diag['stderr'] = (err?.stderr?.toString?.() || '').trim().slice(0, 200) || '(empty)';

    const detail = Object.entries(diag).map(([k, v]) => `${k}=${v}`).join(' | ');
    onEvent({
      type: 'error',
      message: `Installed binary failed to run: ${detail}`,
      category: 'runtime',
      retryable: false,
      hint: `The binary was downloaded successfully but cannot execute on your system. ` +
        `This may indicate missing system dependencies (e.g. VC++ runtime on Windows). ` +
        `Try installing ${agentName} manually: ${def.installUrl ?? ''}`,
    });
    return;
  }

  // ── Phase 7: PATH Update ──
  onEvent({ type: 'phase', phase: 'path', message: 'Configuring environment PATH...' });

  // Bundled layout: the binary lives in <installRoot>/bin/, so put that dir
  // on PATH (binDir itself only holds single-binary agents).
  const pathDir = bundled ? path.dirname(targetPath) : binDir;
  const pathMsg = addToUserPath(pathDir);
  onEvent({ type: 'log', message: pathMsg });

  // ── Done ──
  onEvent({
    type: 'done',
    message: `${agentName} installed successfully`,
    binaryPath: targetPath,
    version: installedVersion,
  });
}

// ─── script Install Strategy ───────────────────────────────────────────────

/**
 * Outcome of a spawned installer script process.
 * `stderrTail` keeps only the last ~8KB — enough for error classification
 * without unbounded memory on chatty installers.
 */
export interface RunScriptResult {
  code: number | null;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunScriptArgs {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine: (line: string) => void;
}

/**
 * Test seam for {@link installFromScript}. Every side effect (network,
 * filesystem, child processes) is injectable so integration tests can drive
 * the full state machine — success, network failure, timeout, abort,
 * validation failure — without real downloads or installs.
 */
export interface ScriptInstallDeps {
  downloadScript?: (url: string, signal?: AbortSignal) => Promise<Buffer>;
  writeTempScript?: (content: Buffer, isWindows: boolean) => string;
  cleanupTempScript?: (scriptPath: string) => void;
  probeNetwork?: (url: string, timeoutMs: number) => Promise<boolean>;
  findShell?: (isWindows: boolean) => string | null;
  runScript?: (args: RunScriptArgs) => Promise<RunScriptResult>;
  resolveBinary?: (def: RuntimeAgentDef) => string | null;
  runVerify?: (binary: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

/** Max installer script size — anything larger is a misconfigured mirror. */
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;
/** Default script install timeout (source installs bootstrap toolchains). */
const DEFAULT_SCRIPT_TIMEOUT_MS = 600_000;
/** Per-invocation timeout for post-install verify args. */
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Default CN PyPI mirror used when pypi.org is unreachable (内网/信创).
 * Aliyun first per the root CLAUDE.md 信创原则: *.aliyun.com/*.aliyuncs.com is
 * typically allow-listed on isolated networks, and an overseas source must never
 * be the only path. The install script's own pinned uv/pip honors these index
 * env vars even under `UV_NO_CONFIG=1` (that flag only disables config FILES).
 */
const DEFAULT_PYPI_MIRROR = 'https://mirrors.aliyun.com/pypi/simple/';

/** Index env keys read by uv (UV_DEFAULT_INDEX current / UV_INDEX_URL legacy)
 *  and pip (PIP_INDEX_URL). We set all three so the redirect works whichever
 *  tool the installer's dependency sync ends up using. */
const PYPI_INDEX_ENV_KEYS = ['UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'PIP_INDEX_URL'] as const;

/**
 * Inject a PyPI/uv index into `env` (mutated in place) so the installer's
 * Python dependency sync can reach a mirror when the default index is blocked.
 *
 * Precedence (highest first):
 *  1. explicit `MOLIO_PYPI_MIRROR` — always applied;
 *  2. a uv/pip index the user already exported — left untouched (never clobber
 *     an intentional private-index setup);
 *  3. otherwise probe pypi.org and fall back to {@link DEFAULT_PYPI_MIRROR}
 *     ONLY when it is unreachable, so users with a working pypi.org keep the
 *     stock behavior.
 *
 * @internal exported for testing.
 */
export async function applyPypiMirrorEnv(
  env: NodeJS.ProcessEnv,
  probe: (url: string, timeoutMs: number) => Promise<boolean>,
  onEvent: (event: InstallEvent) => void,
): Promise<void> {
  const setIndex = (url: string) => {
    for (const key of PYPI_INDEX_ENV_KEYS) env[key] = url;
  };

  const explicit = env['MOLIO_PYPI_MIRROR'];
  if (explicit && explicit.trim()) {
    setIndex(explicit.trim());
    onEvent({ type: 'log', message: `PyPI mirror (MOLIO_PYPI_MIRROR): ${explicit.trim()}` });
    return;
  }

  // Respect a pre-existing uv/pip index — don't override an explicit setup.
  if (PYPI_INDEX_ENV_KEYS.some((k) => env[k] && env[k]!.trim())) {
    return;
  }

  const pypiReachable = await probe('https://pypi.org', 5_000);
  if (!pypiReachable) {
    setIndex(DEFAULT_PYPI_MIRROR);
    onEvent({
      type: 'log',
      message: "pypi.org is not reachable — routing the installer's Python " +
        `dependency sync through a mirror (${DEFAULT_PYPI_MIRROR}). ` +
        'Set MOLIO_PYPI_MIRROR to override.',
    });
  }
}

/**
 * Inject `UV_PYTHON_INSTALL_MIRROR` into `env` (mutated in place) so uv pulls
 * its managed CPython (python-build-standalone) from a CN-reachable mirror.
 *
 * Why this is separate from {@link applyPypiMirrorEnv}: the interpreter is NOT
 * a PyPI package. uv fetches it from GitHub's release-asset CDN
 * (`objects.githubusercontent.com`), which is commonly throttled/reset on CN
 * networks EVEN WHEN `github.com` itself is reachable — so the preflight
 * github.com probe passes, the git clone succeeds, then the ~160MB PBS download
 * stalls at 0 bytes and the install dies on the wall-clock timeout. uv replaces
 * the GitHub release-download base with this mirror, keeping `/{tag}/{file}`;
 * npmmirror's PBS binary layout matches (same source python-provision.ts uses).
 *
 * Precedence (highest first):
 *  1. explicit `MOLIO_PYTHON_MIRROR` (shared with python-provision) — always applied;
 *  2. a `UV_PYTHON_INSTALL_MIRROR` the user already exported — left untouched;
 *  3. otherwise probe npmmirror and use it ONLY when reachable, so networks that
 *     can't reach aliyun (overseas without the mirror) keep the stock GitHub path.
 *
 * @internal exported for testing.
 */
export async function applyPythonInstallMirrorEnv(
  env: NodeJS.ProcessEnv,
  probe: (url: string, timeoutMs: number) => Promise<boolean>,
  onEvent: (event: InstallEvent) => void,
): Promise<void> {
  const normalize = (url: string) => url.trim().replace(/\/+$/, '');

  const explicit = env['MOLIO_PYTHON_MIRROR'];
  if (explicit && explicit.trim()) {
    env['UV_PYTHON_INSTALL_MIRROR'] = normalize(explicit);
    onEvent({ type: 'log', message: `uv Python install mirror (MOLIO_PYTHON_MIRROR): ${env['UV_PYTHON_INSTALL_MIRROR']}` });
    return;
  }

  // Respect a pre-existing mirror — don't override an explicit setup.
  if (env['UV_PYTHON_INSTALL_MIRROR'] && env['UV_PYTHON_INSTALL_MIRROR']!.trim()) {
    return;
  }

  const mirrorReachable = await probe(`${NPMMIRROR_BASE}/`, 5_000);
  if (mirrorReachable) {
    env['UV_PYTHON_INSTALL_MIRROR'] = NPMMIRROR_BASE;
    onEvent({
      type: 'log',
      message: "Routing uv's managed-Python (python-build-standalone) download " +
        `through the npmmirror mirror (${NPMMIRROR_BASE}) — GitHub's release CDN ` +
        'often stalls on CN networks. Set MOLIO_PYTHON_MIRROR to override.',
    });
  }
}

// ─── Installer lockfile CN-mirror rewriting (mirrorLockfile hook) ──────────

/**
 * GitHub proxy prefixes probed (in order) when `MOLIO_GITHUB_PROXY` is unset.
 * Both are public "paste the whole GitHub URL after the prefix" accelerators
 * commonly reachable from CN networks. First probe success wins. Integrity is
 * never delegated to them: the lockfile's own sha256 pins verify every byte,
 * so a proxy can slow down or fail, but it cannot swap content.
 */
const GITHUB_PROXY_CANDIDATES = ['https://ghfast.top', 'https://gh-proxy.com'];

/**
 * Upstream's content-addressed artifact mirror (pm/artifact-mirror.json:
 * origin + prefix). Hosts a reviewed copy of every sha256-pinned lockfile
 * artifact, so any pinned URL can be replaced by `<base>/<sha256>`. Last
 * resort in the probe chain — the GitHub proxies are faster from CN when up.
 */
const HERMES_ASSETS_SHA_BASE = 'https://hermes-assets.nousresearch.com/upstream/sha256';

/** npmmirror's Node.js dist mirror — layout matches nodejs.org/dist (`/vX.Y.Z/<file>`). */
const NPMMIRROR_NODE_DIST_BASE = 'https://registry.npmmirror.com/-/binary/node';

/** Full lowercase sha256 — the lockfile pin format (pm object_key rejects anything else). */
const SHA256_RE = /^[a-f0-9]{64}$/;

/** How a resolved mirror rewrites lockfile download URLs. */
export type LockMirror =
  /** Prefix mode: `https://github.com/<path>` → `<base>/https://github.com/<path>`. */
  | { kind: 'prefix'; base: string }
  /** sha256 mode: any pinned http(s) URL → `<base>/<sha256>`. */
  | { kind: 'sha256'; base: string };

interface LockMirrorSamples {
  /** First github.com URL in the lockfile (probe target for prefix candidates). */
  githubUrl?: string;
  /** First artifact sha256 (probe target for the content-addressed mirror). */
  sha256?: string;
}

/**
 * Decide which mirror lockfile URLs should be rewritten through.
 *
 * Precedence (highest first):
 *  1. `MOLIO_GITHUB_PROXY=off` → no rewriting (explicit user opt-out);
 *  2. `MOLIO_GITHUB_PROXY=<base>` → prefix mode, trusted without probing
 *     (same "explicit config always applies" rule as applyPypiMirrorEnv);
 *  3. probe the public GitHub-proxy candidates with a REAL lockfile URL —
 *     first reachable wins;
 *  4. probe the upstream sha256-addressed mirror with a real artifact sha;
 *  5. nothing reachable → null: keep upstream URLs. A slow download can
 *     resume (pm partials are durable, 6h GC grace); a rewrite to a dead
 *     mirror would hard-fail, so "no mirror" must never force one.
 *
 * @internal exported for testing.
 */
export async function resolveLockMirror(
  env: NodeJS.ProcessEnv,
  probe: (url: string, timeoutMs: number) => Promise<boolean>,
  samples: LockMirrorSamples,
  onEvent: (event: InstallEvent) => void,
): Promise<LockMirror | null> {
  const normalize = (url: string) => url.trim().replace(/\/+$/, '');

  const explicit = env['MOLIO_GITHUB_PROXY'];
  if (explicit && explicit.trim()) {
    const value = explicit.trim();
    if (value.toLowerCase() === 'off') {
      onEvent({ type: 'log', message: 'Lockfile mirror rewriting disabled (MOLIO_GITHUB_PROXY=off)' });
      return null;
    }
    onEvent({ type: 'log', message: `GitHub mirror (MOLIO_GITHUB_PROXY): ${normalize(value)}` });
    return { kind: 'prefix', base: normalize(value) };
  }

  if (samples.githubUrl) {
    for (const candidate of GITHUB_PROXY_CANDIDATES) {
      if (await probe(`${candidate}/${samples.githubUrl}`, 8_000)) {
        onEvent({ type: 'log', message: `GitHub proxy reachable: ${candidate} — lockfile downloads will use it` });
        return { kind: 'prefix', base: candidate };
      }
    }
  }

  if (samples.sha256) {
    if (await probe(`${HERMES_ASSETS_SHA_BASE}/${samples.sha256}`, 8_000)) {
      onEvent({ type: 'log', message: `Upstream artifact mirror reachable: ${HERMES_ASSETS_SHA_BASE}` });
      return { kind: 'sha256', base: HERMES_ASSETS_SHA_BASE };
    }
  }

  onEvent({
    type: 'log',
    message: 'No CN-reachable GitHub mirror found — keeping upstream download URLs ' +
      '(set MOLIO_GITHUB_PROXY to override, or =off to silence this probe).',
  });
  return null;
}

/**
 * Rewrite download URLs in a pm-style JSON lockfile to go through `mirror`.
 *
 * Shape handled: `{ packages: { <name>: { artifacts: { <target>: entry } } } }`
 * where `entry` is `{ url, sha256 }` OR a LIST of such objects (multi-candidate
 * artifacts — iron-proxy/tirith/llamacpp-cuda ship lists).
 *
 * Rewrite rules:
 *  - prefix mode: `https://github.com/…` and `https://raw.githubusercontent.com/…`
 *    → `<base>/<original-url>`; `https://nodejs.org/dist/<rest>` →
 *    `<NPMMIRROR_NODE_DIST_BASE>/<rest>`. Everything else (npm registry,
 *    playwright CDN, docker://, …) untouched.
 *  - sha256 mode: any http(s) URL whose entry carries a full 64-hex sha256 pin
 *    → `<base>/<sha256>`. Non-http URLs (docker://…) and unpinned entries
 *    untouched.
 *
 * `sha256` fields themselves are NEVER modified — they are the integrity
 * anchor that makes any URL swap safe (the installer verifies every downloaded
 * byte). The write is atomic (tmp + rename in the same directory) and the
 * rewrite is idempotent (already-prefixed URLs are skipped). Malformed JSON or
 * an unreadable file → `{ rewritten: 0 }`, file left alone.
 *
 * @internal exported for testing.
 */
export function rewriteLockfileMirrors(
  lockPath: string,
  mirror: LockMirror,
): { rewritten: number } {
  let doc: unknown;
  try {
    // Tolerate a leading BOM — the installer's own python reads lock files
    // with encoding='utf-8-sig'.
    doc = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { rewritten: 0 };
  }

  const packages = (doc as { packages?: unknown })?.packages;
  if (!packages || typeof packages !== 'object') return { rewritten: 0 };

  let rewritten = 0;

  const rewriteUrl = (url: unknown, sha: unknown): string | null => {
    if (typeof url !== 'string' || !url) return null;
    if (mirror.kind === 'sha256') {
      if (!/^https?:\/\//.test(url)) return null;
      if (typeof sha !== 'string' || !SHA256_RE.test(sha)) return null;
      const next = `${mirror.base}/${sha}`;
      return next === url ? null : next;
    }
    // prefix mode
    if (url.startsWith(`${mirror.base}/`)) return null; // idempotent
    if (url.startsWith('https://github.com/') || url.startsWith('https://raw.githubusercontent.com/')) {
      return `${mirror.base}/${url}`;
    }
    const nodeDistPrefix = 'https://nodejs.org/dist/';
    if (url.startsWith(nodeDistPrefix)) {
      return `${NPMMIRROR_NODE_DIST_BASE}/${url.slice(nodeDistPrefix.length)}`;
    }
    return null;
  };

  const visitEntry = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as { url?: unknown; sha256?: unknown };
    const next = rewriteUrl(e.url, e.sha256);
    if (next) {
      e.url = next;
      rewritten++;
    }
  };

  for (const pkg of Object.values(packages) as Array<{ artifacts?: unknown }>) {
    const artifacts = pkg?.artifacts;
    if (!artifacts || typeof artifacts !== 'object') continue;
    for (const art of Object.values(artifacts)) {
      if (Array.isArray(art)) art.forEach(visitEntry);
      else visitEntry(art);
    }
  }

  if (rewritten === 0) return { rewritten: 0 };

  const tmpPath = `${lockPath}.molio-mirror.tmp`;
  writeFileSync(tmpPath, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmpPath, lockPath);
  return { rewritten };
}

/** Extract probe samples (first github URL + first artifact sha) from a lockfile. */
function sampleLockfileUrls(lockPath: string): LockMirrorSamples {
  const samples: LockMirrorSamples = {};
  try {
    const doc = JSON.parse(readFileSync(lockPath, 'utf8').replace(/^﻿/, '')) as {
      packages?: Record<string, { artifacts?: Record<string, unknown> }>;
    };
    for (const pkg of Object.values(doc?.packages ?? {})) {
      for (const art of Object.values(pkg?.artifacts ?? {})) {
        for (const entry of (Array.isArray(art) ? art : [art]) as Array<{ url?: unknown; sha256?: unknown }>) {
          if (!entry || typeof entry !== 'object') continue;
          if (!samples.githubUrl && typeof entry.url === 'string' && entry.url.startsWith('https://github.com/')) {
            samples.githubUrl = entry.url;
          }
          if (!samples.sha256 && typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256)) {
            samples.sha256 = entry.sha256;
          }
          if (samples.githubUrl && samples.sha256) return samples;
        }
      }
    }
  } catch { /* best effort — resolveLockMirror degrades gracefully without samples */ }
  return samples;
}

/** Expand `%VAR%` (Windows) and leading `~` (POSIX home) in an installer home path. */
function expandHomePath(raw: string, env: NodeJS.ProcessEnv): string {
  let out = raw;
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(env['HOME'] || os.homedir(), out.slice(1));
  }
  return out.replace(/%([A-Za-z0-9_]+)%/g, (m, name: string) => env[name] ?? m);
}

/**
 * Best-effort CN-mirror rewrite of the installer's JSON lockfile — the engine
 * side of the `mirrorLockfile` hook. Called after `cfg.afterStage` completes:
 * the tool's repo is on disk (so the lockfile exists) but dependency/tool
 * downloads have not started yet.
 *
 * NEVER fails the install: every error path (missing lockfile, unreadable
 * JSON, rename failure, no reachable mirror) degrades to a logged warning and
 * keeps the upstream URLs — worst case the install is as slow as it was
 * before this hook existed.
 *
 * @internal exported for testing.
 */
export async function applyLockfileMirror(
  env: NodeJS.ProcessEnv,
  cfg: NonNullable<ScriptInstallSource['mirrorLockfile']>,
  probe: (url: string, timeoutMs: number) => Promise<boolean>,
  onEvent: (event: InstallEvent) => void,
): Promise<void> {
  try {
    const isWindows = process.platform === 'win32';
    const homeRaw =
      (cfg.homeEnv && env[cfg.homeEnv]?.trim()) ||
      cfg.defaultHome[isWindows ? 'win32' : 'posix'];
    const lockPath = path.join(expandHomePath(homeRaw, env), cfg.relPath);

    if (!existsSync(lockPath)) {
      onEvent({ type: 'log', message: `Mirror hook: lockfile not found (${lockPath}) — skipping rewrite` });
      return;
    }

    // Probe with REAL lockfile values so the reachability check hits the same
    // hosts/shas the installer will actually download.
    const mirror = await resolveLockMirror(env, probe, sampleLockfileUrls(lockPath), onEvent);
    if (!mirror) return;

    const { rewritten } = rewriteLockfileMirrors(lockPath, mirror);
    onEvent({
      type: 'log',
      message: rewritten > 0
        ? `Rewrote ${rewritten} lockfile download URL(s) via ${mirror.kind === 'prefix' ? mirror.base : `${mirror.base}/<sha256>`}`
        : 'Lockfile needs no mirror rewrite',
    });
  } catch (err) {
    onEvent({
      type: 'log',
      message: `Mirror rewrite skipped (${err instanceof Error ? err.message : String(err)}) — keeping upstream URLs`,
    });
  }
}

/**
 * Surgically rewrite the value of ONE git-config key inside its section, and
 * only when the current value equals `fromValue` (case-insensitive). Never adds
 * a section or key, never touches any other line. Pure + synchronous so it can
 * be unit-tested without a filesystem.
 *
 * Dotted key → section header mapping mirrors git's own:
 *   `remote.origin.partialclonefilter` → `[remote "origin"]`, key `partialclonefilter`
 *   `core.bare`                        → `[core]`,           key `bare`
 * The subsection comparison is case-sensitive for the quoted part only insofar
 * as git treats remote names case-sensitively; we lowercase both sides here
 * because the installer's own remote is always the plain `origin`.
 *
 * Preserves the file's dominant line ending and each key's quoting style
 * (`key = value` vs `key = "value"`). Returns `{ text, changed }`; `text` is the
 * ORIGINAL string when nothing matched (so callers can skip the write).
 *
 * @internal exported for testing.
 */
export function rewriteGitConfigValue(
  configText: string,
  key: string,
  fromValue: string,
  toValue: string,
): { text: string; changed: boolean } {
  const parts = key.split('.');
  if (parts.length < 2) return { text: configText, changed: false };
  const section = (parts[0] ?? '').toLowerCase();
  // Everything between the first and last dot is the (optional) subsection.
  const subsection = parts.length >= 3 ? parts.slice(1, -1).join('.').toLowerCase() : null;
  const keyName = (parts[parts.length - 1] ?? '').toLowerCase();

  const eol = configText.includes('\r\n') ? '\r\n' : '\n';
  const lines = configText.split(/\r?\n/);
  // `[section]` or `[section "subsection"]` — subsection may contain spaces.
  const headerRe = /^\[\s*([A-Za-z0-9.\-]+)\s*(?:"([^"]*)")?\s*\]$/;
  // `name = value` — value may be quoted and/or carry a trailing comment.
  const kvRe = /^(\s*)([A-Za-z0-9\-]+)\s*=\s*(.*)$/;

  let inTargetSection = false;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const hm = headerRe.exec(trimmed);
    if (hm) {
      const sec = (hm[1] ?? '').toLowerCase();
      const sub = hm[2]; // undefined when the header has no quoted subsection
      inTargetSection =
        sec === section &&
        (subsection === null
          ? sub === undefined
          : sub !== undefined && sub.toLowerCase() === subsection);
      continue;
    }

    if (!inTargetSection) continue;

    const km = kvRe.exec(line);
    if (!km) continue;
    const indent = km[1] ?? '';
    const name = km[2] ?? '';
    const rawVal = (km[3] ?? '').trim();
    if (name.toLowerCase() !== keyName) continue;

    const quoted = /^"(.*)"$/.exec(rawVal);
    const bare = quoted ? (quoted[1] ?? '') : rawVal;
    if (bare.toLowerCase() !== fromValue.toLowerCase()) continue;

    const newVal = quoted ? `"${toValue}"` : toValue;
    lines[i] = `${indent}${name} = ${newVal}`;
    changed = true;
    break; // first match in the section wins (git semantics)
  }

  return { text: changed ? lines.join(eol) : configText, changed };
}

/**
 * Best-effort engine side of the `repairGitConfig` hook. After `afterStage`,
 * locates `<home>/<repoRelPath>/.git/config` and stamps the modern partial-clone
 * filter over a legacy one so the tool's next-run history backfill (~100MB+) is
 * skipped. NEVER fails the install — every miss (no file, no matching section/
 * key/value, IO error) degrades to a logged no-op.
 *
 * @internal exported for testing.
 */
export function applyGitConfigRepair(
  env: NodeJS.ProcessEnv,
  cfg: NonNullable<ScriptInstallSource['repairGitConfig']>,
  onEvent: (event: InstallEvent) => void,
): void {
  try {
    const isWindows = process.platform === 'win32';
    const homeRaw =
      (cfg.homeEnv && env[cfg.homeEnv]?.trim()) ||
      cfg.defaultHome[isWindows ? 'win32' : 'posix'];
    const configPath = path.join(
      expandHomePath(homeRaw, env),
      cfg.repoRelPath,
      '.git',
      'config',
    );

    if (!existsSync(configPath)) {
      onEvent({ type: 'log', message: `Git-config repair: not found (${configPath}) — skipping` });
      return;
    }

    const original = readFileSync(configPath, 'utf8');
    const { text, changed } = rewriteGitConfigValue(original, cfg.key, cfg.fromValue, cfg.toValue);
    if (!changed) {
      onEvent({
        type: 'log',
        message: `Git-config repair: '${cfg.key}' is not '${cfg.fromValue}' — nothing to do`,
      });
      return;
    }

    const tmpPath = `${configPath}.molio-repair.tmp`;
    writeFileSync(tmpPath, text, 'utf8');
    renameSync(tmpPath, configPath);
    onEvent({
      type: 'log',
      message: `Git-config repair: set ${cfg.key} = ${cfg.toValue} (skips one-time ~100MB history backfill)`,
    });
  } catch (err) {
    onEvent({
      type: 'log',
      message: `Git-config repair skipped (${err instanceof Error ? err.message : String(err)}) — install continues`,
    });
  }
}

/**
 * @internal exported for testing — tests drive this directly with synthetic
 * defs/sources so scenarios (unsupported platform, missing shell) don't
 * depend on the host machine or the real hermes registry entry.
 */
export async function installFromScript(
  def: RuntimeAgentDef,
  source: ScriptInstallSource,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
  deps?: ScriptInstallDeps,
): Promise<void> {
  const agentName = def.name;
  const isWindows = process.platform === 'win32';

  // ── Phase 1: Preflight ──
  onEvent({ type: 'phase', phase: 'preflight', message: 'Checking system environment...' });

  const platformKey = getPlatformKey();
  onEvent({ type: 'log', message: `Platform: ${platformKey}` });

  if (def.install?.requirements?.supportedPlatforms?.length) {
    const allowed = def.install.requirements.supportedPlatforms;
    if (!allowed.includes(platformKey)) {
      onEvent({
        type: 'error',
        message: `Unsupported platform: ${platformKey}`,
        category: 'platform',
        retryable: false,
        hint: `Supported platforms: ${allowed.join(', ')}.`,
      });
      return;
    }
  }

  const scriptUrl = source.scripts[platformKey];
  if (!scriptUrl) {
    onEvent({
      type: 'error',
      message: `No installer script for platform: ${platformKey}`,
      category: 'platform',
      retryable: false,
      hint: `Supported platforms: ${Object.keys(source.scripts).join(', ')}. ` +
        `Install ${agentName} manually: ${def.installUrl ?? 'the project website'}`,
    });
    return;
  }

  // Shell the installer script runs under: pwsh → powershell on Windows,
  // bash everywhere else.
  const findShellFn = deps?.findShell ?? findInstallerShell;
  const shellCmd = findShellFn(isWindows);
  if (!shellCmd) {
    onEvent({
      type: 'error',
      message: isWindows ? 'PowerShell not found' : 'bash not found',
      category: 'platform',
      retryable: false,
      hint: isWindows
        ? `The ${agentName} installer requires PowerShell. Restore Windows PowerShell ` +
          `or install pwsh, then retry.`
        : `The ${agentName} installer requires bash.`,
    });
    return;
  }
  onEvent({ type: 'log', message: `Installer shell: ${shellCmd}` });

  // Soft reachability probe — official scripts clone the repo and download
  // toolchain bits from GitHub. Unreachable is a warning, not a blocker:
  // HERMES_REPO_URL mirrors and system proxies can still carry the install.
  const probeFn = deps?.probeNetwork ?? probeUrlReachable;
  const githubReachable = await probeFn('https://github.com', 5_000);
  if (!githubReachable) {
    onEvent({
      type: 'log',
      message: 'Warning: github.com is not reachable — the installer downloads ' +
        'dependencies from GitHub and may fail. Consider a proxy or a repo mirror ' +
        '(MOLIO_HERMES_REPO_URL).',
    });
  }

  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }

  // ── Phase 2: Download the installer script ──
  onEvent({ type: 'phase', phase: 'download', message: 'Downloading installer script...' });

  let scriptBuf: Buffer;
  try {
    scriptBuf = deps?.downloadScript
      ? await deps.downloadScript(scriptUrl, signal)
      : await downloadOnce(scriptUrl, onEvent, signal, 30_000);
  } catch (err) {
    if (signal?.aborted) {
      onEvent({ type: 'error', message: 'Installation cancelled during download', category: 'unknown', retryable: true });
      return;
    }
    onEvent({
      type: 'error',
      message: `Failed to download installer script: ${err instanceof Error ? err.message : String(err)}`,
      category: 'network',
      retryable: true,
      hint: 'Check your network connection and try again.',
    });
    return;
  }

  // Guard against captive portals / error pages masquerading as the script.
  if (scriptBuf.length > MAX_SCRIPT_BYTES) {
    onEvent({
      type: 'error',
      message: `Installer script is too large (${scriptBuf.length} bytes) — expected a text script`,
      category: 'network',
      retryable: true,
      hint: 'A proxy or mirror may have returned unexpected content. Try again.',
    });
    return;
  }
  const head = scriptBuf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    onEvent({
      type: 'error',
      message: 'Downloaded installer is an HTML page, not a script',
      category: 'network',
      retryable: true,
      hint: 'A proxy or captive portal intercepted the download. ' +
        'Check your network settings and try again.',
    });
    return;
  }

  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }

  let scriptPath: string;
  try {
    scriptPath = deps?.writeTempScript
      ? deps.writeTempScript(scriptBuf, isWindows)
      : writeTempScriptFile(scriptBuf, isWindows);
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to write installer script: ${err instanceof Error ? err.message : String(err)}`,
      category: 'permission',
      retryable: false,
      hint: `Check write permissions for ${os.tmpdir()}`,
    });
    return;
  }

  // ── Phase 3: Run the installer ──
  onEvent({ type: 'phase', phase: 'install', message: `Running ${agentName} installer (this can take several minutes)...` });

  const extraArgs = matchPlatformArgs(platformKey, source.platformArgs);
  const timeoutMs = source.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  // Env passthrough: MOLIO_HERMES_REPO_URL → HERMES_REPO_URL lets users point
  // the installer's git clone at a reachable mirror (engine-level convention;
  // no contracts surface for it).
  const env: NodeJS.ProcessEnv = { ...process.env };
  const repoMirror = env['MOLIO_HERMES_REPO_URL'];
  if (repoMirror) {
    env['HERMES_REPO_URL'] = repoMirror;
  }

  // Redirect the installer's Python dependency sync to a reachable PyPI mirror
  // when the default index is blocked (内网/信创). See applyPypiMirrorEnv.
  await applyPypiMirrorEnv(env, probeFn, onEvent);

  // Redirect uv's managed-Python (python-build-standalone) download to the
  // npmmirror mirror when reachable — GitHub's release CDN stalls on CN networks
  // even though github.com itself probes fine. See applyPythonInstallMirrorEnv.
  await applyPythonInstallMirrorEnv(env, probeFn, onEvent);

  const onLine = (line: string) => {
    if (line.trim()) onEvent({ type: 'log', message: line });
  };

  const runOnce = (stageArgs: string[]): Promise<RunScriptResult> => {
    const cmdArgs = isWindows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', scriptPath, '-NonInteractive', ...extraArgs, ...stageArgs]
      : [scriptPath, '--non-interactive', ...extraArgs, ...stageArgs];
    return deps?.runScript
      ? deps.runScript({ cmd: shellCmd, args: cmdArgs, env, timeoutMs, signal, onLine })
      : runScriptProcess({ cmd: shellCmd, args: cmdArgs, env, timeoutMs, signal, onLine });
  };

  // Failure captured inside the run loop, surfaced after temp-script cleanup.
  let failure: { message: string; category: ErrorCategory; retryable: boolean; hint?: string } | null = null;
  let cancelled = false;

  try {
    if (source.stages?.length) {
      // Stage protocol: one script invocation per stage (`-Stage NAME` /
      // `--stage NAME`) instead of a single full-ladder run, so the engine can
      // check abort between stages and inject the mirrorLockfile hook after
      // the clone stage. `timeoutMs` is a PER-STAGE budget here — each stage
      // run gets the full timeout.
      let mirrorPending = source.mirrorLockfile ?? null;
      let gitRepairPending = source.repairGitConfig ?? null;
      for (const stage of source.stages) {
        if (signal?.aborted) { cancelled = true; break; }
        onEvent({ type: 'log', message: `Installer stage: ${stage}` });
        const result = await runOnce(isWindows ? ['-Stage', stage] : ['--stage', stage]);

        if (result.aborted || signal?.aborted) { cancelled = true; break; }
        if (result.timedOut) {
          failure = {
            message: `Installer timed out after ${Math.round(timeoutMs / 1000)}s (stage: ${stage})`,
            category: 'runtime',
            retryable: true,
            hint: `Source-based installs can be slow on first run (toolchain bootstrap). ` +
              `Try again, or install ${agentName} manually: ${def.installUrl ?? ''}`,
          };
          break;
        }
        if (result.code !== 0) {
          const classified = classifyScriptExitError(result.stderrTail, result.code, def.installUrl);
          failure = {
            message: `Installer stage '${stage}' exited with code ${result.code}${classified.detail ? `: ${classified.detail}` : ''}`,
            category: classified.category,
            retryable: classified.retryable,
            hint: classified.hint,
          };
          break;
        }
        onEvent({ type: 'log', message: `Stage complete: ${stage}` });

        // One-shot hook: rewrite the freshly-cloned lockfile's download URLs
        // to CN-reachable mirrors BEFORE the dependency stages start pulling.
        // The repository stage hard-resets the checkout on every run (so a
        // previous rewrite is wiped on retry) — hence the hook lives in the
        // loop and re-applies each run. Best-effort; never fails the install.
        if (mirrorPending && stage === mirrorPending.afterStage) {
          await applyLockfileMirror(env, mirrorPending, probeFn, onEvent);
          mirrorPending = null;
        }

        // One-shot hook: stamp the modern partial-clone filter over a legacy
        // `tree:0` checkout BEFORE the products/maintenance stage runs the
        // tool's own treeless→blobless migration (which would otherwise
        // re-fetch ~100MB of history and blow the per-stage budget). Same
        // re-applies-each-run rationale as the mirror hook (repository
        // hard-resets the checkout). Best-effort; never fails the install.
        if (gitRepairPending && stage === gitRepairPending.afterStage) {
          applyGitConfigRepair(env, gitRepairPending, onEvent);
          gitRepairPending = null;
        }
      }
    } else {
      const result = await runOnce([]);
      if (result.aborted || signal?.aborted) {
        cancelled = true;
      } else if (result.timedOut) {
        failure = {
          message: `Installer timed out after ${Math.round(timeoutMs / 1000)}s`,
          category: 'runtime',
          retryable: true,
          hint: `Source-based installs can be slow on first run (toolchain bootstrap). ` +
            `Try again, or install ${agentName} manually: ${def.installUrl ?? ''}`,
        };
      } else if (result.code !== 0) {
        const classified = classifyScriptExitError(result.stderrTail, result.code, def.installUrl);
        failure = {
          message: `Installer exited with code ${result.code}${classified.detail ? `: ${classified.detail}` : ''}`,
          category: classified.category,
          retryable: classified.retryable,
          hint: classified.hint,
        };
      }
    }
  } finally {
    // Always remove the temp script, success or failure.
    try {
      if (deps?.cleanupTempScript) deps.cleanupTempScript(scriptPath);
      else unlinkSync(scriptPath);
    } catch { /* best effort */ }
  }

  if (cancelled) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }
  if (failure) {
    onEvent({ type: 'error', ...failure });
    return;
  }
  onEvent({ type: 'log', message: 'Installer script completed' });

  // ── Phase 4: Validate the installation ──
  onEvent({ type: 'phase', phase: 'validate', message: 'Verifying installation...' });

  const binary = deps?.resolveBinary
    ? deps.resolveBinary(def)
    : resolveAgentBinary(def).binary;
  if (!binary) {
    onEvent({
      type: 'error',
      message: `${agentName} binary (${def.bin}) not found after install`,
      category: 'validation',
      retryable: false,
      hint: `The installer finished but the binary could not be located. ` +
        `Restart Molio so PATH changes take effect, or install ${agentName} manually: ${def.installUrl ?? ''}`,
    });
    return;
  }
  onEvent({ type: 'log', message: `Binary found: ${binary}` });

  let installedVersion: string | undefined;
  for (const verifyArgs of source.verifyArgs ?? []) {
    const vres = deps?.runVerify
      ? await deps.runVerify(binary, verifyArgs)
      : await runVerifyOnce(binary, verifyArgs);
    if (!vres.ok) {
      const detail = (vres.stderr || vres.stdout).trim().split('\n')[0]?.slice(0, 300) || 'no output';
      onEvent({
        type: 'error',
        message: `Verification failed (${verifyArgs.join(' ')}): ${detail}`,
        category: 'validation',
        retryable: false,
        hint: `The installer ran but ${def.bin} does not work correctly. ` +
          `Try installing ${agentName} manually: ${def.installUrl ?? ''}`,
      });
      return;
    }
    if (verifyArgs.some((a) => a.includes('--version'))) {
      // Empty --version output degrades to unknown version, not a failure —
      // some shims print the version to stderr or nothing at all.
      const firstLine = vres.stdout.trim().split('\n')[0]?.trim();
      if (firstLine) installedVersion = firstLine;
    }
    onEvent({ type: 'log', message: `Verified: ${verifyArgs.join(' ') || '(no args)'}` });
  }

  // ── Phase 5: PATH (daemon process only) ──
  onEvent({ type: 'phase', phase: 'path', message: 'Configuring environment PATH...' });

  // The official installer already manages the USER-level PATH; we only make
  // the binary visible to this daemon process so runs work without a restart.
  const binDir = path.dirname(binary);
  updateCurrentProcessPath(binDir);
  onEvent({ type: 'log', message: `Added ${binDir} to daemon process PATH` });

  // ── Done ──
  onEvent({
    type: 'done',
    message: `${agentName} installed successfully`,
    binaryPath: binary,
    version: installedVersion,
  });
}

// ─── script helpers ─────────────────────────────────────────────────────────

/**
 * Match per-platform-family extra args for a platform key.
 * Keys are platform-key prefixes ('win32' | 'darwin' | 'linux' | …) with the
 * special key 'posix' matching any non-win32 platform. Family-specific wins.
 *
 * @internal exported for testing
 */
export function matchPlatformArgs(
  platformKey: string,
  platformArgs?: Record<string, string[]>,
): string[] {
  if (!platformArgs) return [];
  const family = platformKey.split('-')[0]!;
  if (platformArgs[family]) return platformArgs[family];
  if (family !== 'win32' && platformArgs['posix']) return platformArgs['posix'];
  return [];
}

export interface ClassifiedScriptError {
  category: ErrorCategory;
  retryable: boolean;
  /** First meaningful stderr line (trimmed), for the error message. */
  detail?: string;
  hint?: string;
}

/**
 * Map installer stderr to an ErrorCategory. Network failures dominate in
 * practice — official scripts clone from GitHub and download toolchain
 * binaries (uv, PortableGit) with hardcoded GitHub URLs.
 *
 * @internal exported for testing
 */
export function classifyScriptExitError(
  stderr: string,
  code: number | null,
  installUrl?: string,
): ClassifiedScriptError {
  const text = (stderr || '').toLowerCase();
  const detail = (stderr || '').trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300);

  const networkPatterns = [
    'could not resolve host', 'econnrefused', 'enotfound', 'etimedout',
    'connection timed out', 'unable to access', 'failed to connect',
    'network is unreachable', 'github.com',
  ];
  if (networkPatterns.some((p) => text.includes(p))) {
    return {
      category: 'network',
      retryable: true,
      detail,
      hint: 'The installer needs to reach github.com (repo clone + toolchain downloads). ' +
        'Configure a system proxy, or set MOLIO_HERMES_REPO_URL to a reachable git mirror, ' +
        `or install manually: ${installUrl ?? 'the project website'}`,
    };
  }

  if (text.includes('permission denied') || text.includes('eacces') || text.includes('access is denied')) {
    return {
      category: 'permission',
      retryable: false,
      detail,
      hint: 'Check write permissions for the install directory and try again.',
    };
  }

  return {
    category: 'runtime',
    retryable: true,
    detail: detail ?? (code != null ? `exit code ${code}` : undefined),
  };
}

/** Locate the shell used to run installer scripts: pwsh → powershell / bash. */
function findInstallerShell(isWindows: boolean): string | null {
  const candidates = isWindows ? ['pwsh', 'powershell'] : ['bash'];
  for (const cmd of candidates) {
    try {
      execFileSync(isWindows ? 'where' : 'which', [cmd], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

/** HEAD-probe a URL; resolves false on any error/timeout (never throws). */
function probeUrlReachable(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/** Write the downloaded script to a temp file (POSIX: chmod 0755 + LF endings). */
function writeTempScriptFile(content: Buffer, isWindows: boolean): string {
  const ext = isWindows ? '.ps1' : '.sh';
  const file = path.join(
    os.tmpdir(),
    `molio-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  if (isWindows) {
    writeFileSync(file, content);
  } else {
    // Normalize CRLF → LF defensively: bash chokes on \r line endings.
    writeFileSync(file, content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    chmodSync(file, 0o755);
  }
  return file;
}

/**
 * Spawn the installer script, streaming stdout/stderr line-by-line to onLine.
 * Enforces an absolute timeout and abort support: the whole process TREE is
 * signalled (SIGTERM first, SIGKILL 3s later if it ignores it). Never rejects —
 * the result object carries the failure mode (code / timedOut / aborted).
 *
 * Two hardening details, both learned from a real orphaned-installer bug:
 *  - POSIX: the child is spawned `detached` so it becomes its own process-group
 *    leader; killTree signals the negative pid to reach subshells the installer
 *    forks (git clone, package managers). Without this, grandchildren survive
 *    abort/timeout, keep downloading, and keep the stdio pipes open.
 *  - settle() is driven by 'close' (full output drained) but backstopped by
 *    'exit' + a short grace timer: if some fd on the pipe is still held after
 *    the direct child exits, we still resolve instead of hanging forever.
 *
 * Exported for integration tests that spawn a real (tree-forking) subprocess.
 */
export function runScriptProcess(args: RunScriptArgs): Promise<RunScriptResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child: ChildProcess = spawn(args.cmd, args.args, {
      env: args.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so killTree can signal the whole tree.
      // On win32 `detached` would spawn a new console window; we tree-kill via
      // `taskkill /T` instead, so keep it false there.
      detached: !isWin,
    });

    let stderrTail = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitFallback: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, args.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', args.onLine);
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        stderrTail += line + '\n';
        if (stderrTail.length > 8_000) stderrTail = stderrTail.slice(-8_000);
        args.onLine(line);
      });
    }

    const settle = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitFallback) clearTimeout(exitFallback);
      args.signal?.removeEventListener('abort', onAbort);
      resolve({
        code: spawnError ? 1 : code,
        stderrTail: spawnError
          ? `${stderrTail}\n${spawnError}`.trim()
          : stderrTail.trim(),
        timedOut,
        aborted,
      });
    };

    child.on('error', (err) => settle(null, `spawn failed: ${err.message}`));
    // Primary: 'close' fires once every stdio fd is closed → stderrTail complete.
    child.on('close', (code) => settle(code));
    // Backstop: the direct child exited but a lingering fd (e.g. a grandchild
    // that escaped the group kill) could keep 'close' from ever firing. Give the
    // pipes a short grace period to drain, then force-settle so we never hang.
    child.on('exit', (code) => {
      exitFallback = setTimeout(() => settle(code), 2_000);
      exitFallback.unref?.();
    });
  });
}

/** A (pid, ppid) pair from a Windows process-table snapshot. */
export interface ProcPidPair { pid: number; ppid: number; }

/**
 * BFS a process-table snapshot to collect every live descendant of `rootPid`,
 * ordered deepest-first (leaves before their parents) so force-killing can't
 * orphan a child whose parent we kill first. Pure + synchronous for
 * deterministic unit tests.
 *
 * Crucially this works even when `rootPid` itself is ALREADY DEAD: Windows keeps
 * a live process's ParentProcessId pointing at its (dead) parent's pid, so a
 * snapshot taken while the subtree is alive still connects root → child →
 * grandchild. That is the exact gap `taskkill /pid <deadRoot> /T` cannot cover —
 * it errors "process not found", reaps nothing, and leaves the whole subtree
 * running (observed 2026-10-05: an installer's `git fetch` kept writing a 104MB
 * pack for ~9min after the stage was torn down). Cycles from pid reuse are
 * guarded by a visited set.
 *
 * @internal exported for testing.
 */
export function collectDescendants(rootPid: number, procs: ProcPidPair[]): number[] {
  const byParent = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue; // self-parented (System / System Idle) — skip
    const list = byParent.get(p.ppid);
    if (list) list.push(p.pid);
    else byParent.set(p.ppid, [p.pid]);
  }

  const depth = new Map<number, number>([[rootPid, 0]]);
  const visited = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  const found: number[] = [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const childPid of byParent.get(cur) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      depth.set(childPid, (depth.get(cur) ?? 0) + 1);
      found.push(childPid);
      queue.push(childPid);
    }
  }
  // Deepest-first so leaves die before the parents that spawned them.
  return found.sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
}

/**
 * Snapshot the live (pid, ppid) table on Windows via CIM. Returns [] on any
 * failure (constrained shell, timeout, no PowerShell) so the caller degrades
 * gracefully to plain `taskkill /T`. Synchronous on purpose: killTree is a
 * teardown path where a short (~sub-second) block is acceptable, and taking the
 * snapshot atomically before any kill is what makes the deep-descendant sweep
 * correct.
 */
function snapshotWinProcs(): ProcPidPair[] {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { windowsHide: true, timeout: 5_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const procs: ProcPidPair[] = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
      if (m) procs.push({ pid: parseInt(m[1]!, 10), ppid: parseInt(m[2]!, 10) });
    }
    return procs;
  } catch {
    return [];
  }
}

/**
 * Kill the installer's entire process tree, not just the direct child.
 *  - POSIX: the child was spawned `detached`, so it leads its own process group;
 *    signalling `-pid` reaches every subshell the script forked. SIGTERM first,
 *    SIGKILL after 3s.
 *  - win32: snapshot the descendant set up-front (correct even if the root
 *    already exited), `taskkill /T` the root, then force-kill every snapshotted
 *    descendant deepest-first as a backstop for branches `/T` missed. The whole
 *    sweep repeats once after 3s. Every spawned killer carries an 'error'
 *    listener so a failed taskkill can never crash the daemon.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  const isWin = process.platform === 'win32';

  if (!isWin) {
    const signalGroup = (sig: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (pid) process.kill(-pid, sig); // negative pid = whole group (child leads)
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already dead */ }
      }
    };
    signalGroup('SIGTERM');
    const t = setTimeout(() => signalGroup('SIGKILL'), 3_000);
    t.unref?.(); // don't hold the loop open just for the escalation timer
    return;
  }

  // Fire-and-forget a taskkill, swallowing spawn errors (best-effort teardown).
  const spawnKiller = (args: string[]) => {
    try {
      const k = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { /* taskkill missing/denied — nothing more to do */ });
      k.unref?.();
    } catch { /* spawn itself failed — ignore */ }
  };

  // Snapshot BEFORE killing: once the root dies, an intermediate's death can
  // make its own children unreachable to a fresh `taskkill /T` walk.
  const descendants = pid ? collectDescendants(pid, snapshotWinProcs()) : [];

  const sweep = () => {
    if (pid) spawnKiller(['/pid', String(pid), '/T', '/F']);
    for (const dpid of descendants) spawnKiller(['/pid', String(dpid), '/F']);
  };

  sweep();
  const t = setTimeout(sweep, 3_000);
  t.unref?.();
}

/**
 * Run one verify invocation against the resolved binary (15s cap).
 * Mirrors the needsShellOnWindows handling from launch.ts probes — Python
 * venv shims may be extensionless on Windows and need cmd.exe PATHEXT lookup.
 */
function runVerifyOnce(
  binary: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const useShell = needsShellOnWindows(binary);
    execFile(useShell ? `"${binary}"` : binary, args, {
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
      shell: useShell,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ?? '',
        stderr: stderr ?? (err && !stderr ? err.message : ''),
      });
    });
  });
}

// ─── Tarball Naming ────────────────────────────────────────────────────────

/**
 * Build the npm tarball file name for a platform package.
 *
 * npm convention: `{pkgName-without-scope}-{tarballVersion}.tgz`
 * e.g. @anthropic-ai/claude-code-win32-x64 → claude-code-win32-x64-2.1.235.tgz
 *
 * When the package entry carries a `tarballVersion` template, `{version}` is
 * replaced with the resolved version — some publishers (e.g. @openai/codex)
 * ship platform builds as version-suffixed variants of ONE package:
 * codex-0.149.0-win32-x64.tgz instead of a separate per-platform package.
 *
 * @internal exported for testing
 */
export function buildTarballName(
  nativeInfo: NpmNativeInstallSource['packages'][string],
  resolvedVersion: string,
): string {
  const pkgShortName = nativeInfo.pkgName.split('/').pop()!;
  const tarballVersion = nativeInfo.tarballVersion
    ? nativeInfo.tarballVersion.split('{version}').join(resolvedVersion)
    : resolvedVersion;
  return `${pkgShortName}-${tarballVersion}.tgz`;
}

// ─── Platform Detection ────────────────────────────────────────────────────

export function getPlatformKey(): string {
  const platform = process.platform;
  const archName = process.arch;

  if (platform === 'linux') {
    const isMusl = detectMusl();
    return `linux-${archName}${isMusl ? '-musl' : ''}`;
  }

  return `${platform}-${archName}`;
}

function detectMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report =
    typeof process.report?.getReport === 'function'
      ? process.report.getReport()
      : null;
  return report != null && (report as any).header?.glibcVersionRuntime === undefined;
}

/**
 * Parse the Windows build number from os.release() (e.g. "10.0.14393" → 14393).
 * Returns null on non-Windows or if parsing fails.
 */
function getWindowsBuildNumber(): number | null {
  if (process.platform !== 'win32') return null;
  const parts = os.release().split('.');
  const build = parseInt(parts[parts.length - 1] || '', 10);
  return Number.isFinite(build) ? build : null;
}

// ─── Version Resolution ────────────────────────────────────────────────────

/** Short timeout for the packument lookup — offline users should hit the fallback fast. */
const RESOLVE_TIMEOUT_MS = 15_000;
const RESOLVE_MAX_RETRIES = 1;

/**
 * Extract `dist-tags.latest` from a registry packument JSON body.
 * @internal exported for testing
 */
export function parseLatestVersionFromPackument(json: string): string | null {
  try {
    const meta = JSON.parse(json);
    const latest = meta?.['dist-tags']?.latest;
    return typeof latest === 'string' && latest.length > 0 ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `latest` version of a package by querying the registries in
 * order (abbreviated packument, `dist-tags.latest`). Returns null when all
 * registries fail — the caller decides on a fallback.
 */
async function resolveLatestVersion(
  encodedPkg: string,
  registries: string[],
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  // Abbreviated packument — much smaller than the full metadata document.
  const headers = { Accept: 'application/vnd.npm.install-v1+json' };

  for (const registry of registries) {
    if (signal?.aborted) return null;

    for (let attempt = 0; attempt <= RESOLVE_MAX_RETRIES; attempt++) {
      if (signal?.aborted) return null;
      try {
        const body = await downloadOnce(
          `${registry}/${encodedPkg}`,
          () => { /* no progress reporting for metadata lookups */ },
          signal,
          RESOLVE_TIMEOUT_MS,
          headers,
        );
        const latest = parseLatestVersionFromPackument(body.toString('utf8'));
        if (latest) return latest;
        // Got a response but no dist-tags.latest — package layout unexpected;
        // don't retry the same registry, move on.
        break;
      } catch (err) {
        if (signal?.aborted) return null;
        if (attempt < RESOLVE_MAX_RETRIES) {
          onEvent({ type: 'log', message: `Version lookup failed, retrying (${attempt + 1}/${RESOLVE_MAX_RETRIES})...` });
          continue;
        }
        onEvent({ type: 'log', message: `Registry ${registry} version lookup failed, trying next...` });
      }
    }
  }
  return null;
}

// ─── Download ──────────────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function downloadWithRetry(
  encodedPkg: string,
  tarballName: string,
  registries: string[],
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let registryIdx = 0;

    const tryNextRegistry = () => {
      if (signal?.aborted) { reject(new Error('Aborted')); return; }
      if (registryIdx >= registries.length) {
        reject(new Error('All registries failed'));
        return;
      }

      const registry = registries[registryIdx];
      const url = `${registry}/${encodedPkg}/-/${tarballName}`;
      registryIdx++;

      let attempt = 0;
      const tryDownload = () => {
        if (signal?.aborted) { reject(new Error('Aborted')); return; }
        attempt++;
        downloadOnce(url, onEvent, signal).then(resolve).catch((err) => {
          if (signal?.aborted) { reject(err); return; }
          if (attempt <= MAX_RETRIES) {
            onEvent({ type: 'log', message: `Download failed, retrying (${attempt}/${MAX_RETRIES})...` });
            tryDownload();
          } else {
            onEvent({ type: 'log', message: `Registry ${registry} failed, trying next...` });
            tryNextRegistry();
          }
        });
      };
      tryDownload();
    };

    tryNextRegistry();
  });
}

function downloadOnce(
  url: string,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
  extraHeaders: Record<string, string> = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let receivedBytes = 0;

    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'molio-installer/1.0', ...extraHeaders },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const location = res.headers.location;
        if (location) {
          downloadOnce(location, onEvent, signal).then(resolve).catch(reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const contentLength = res.headers['content-length'];
      if (contentLength) totalBytes = parseInt(contentLength, 10);

      res.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        chunks.push(chunk);

        if (totalBytes > 0) {
          const percent = Math.floor((receivedBytes / totalBytes) * 100);
          onEvent({
            type: 'progress',
            percent,
            downloadedBytes: receivedBytes,
            totalBytes,
          });
        }
      });

      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });

      res.on('error', (err) => reject(err));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Download timeout'));
    });

    // Abort support
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Aborted'));
      }, { once: true });
    }
  });
}

// ─── Tarball Extraction ─────────────────────────────────────────────────────

/** @internal exported for testing */
export function extractFromTarball(gzipped: Buffer, targetPath: string): Buffer | null {
  const unzipped = gunzipSync(gzipped) as Buffer;
  return extractFileFromTar(unzipped, targetPath);
}

/** Ensure the extract prefix ends with '/' so entry matching is unambiguous. */
function normalizeExtractDir(extractDir: string): string {
  return extractDir.endsWith('/') ? extractDir : `${extractDir}/`;
}

export interface ExtractedFile {
  /** Path relative to the extract prefix, '/'-separated. */
  relPath: string;
  data: Buffer;
}

/**
 * Extract ALL regular files under a tar path prefix (bundled layout).
 * Returns files with paths relative to the prefix, or null when nothing
 * matched. Entries escaping the prefix ('..') are skipped defensively.
 *
 * @internal exported for testing
 */
export function extractTreeFromTarball(
  gzipped: Buffer,
  extractDir: string,
): ExtractedFile[] | null {
  const unzipped = gunzipSync(gzipped) as Buffer;
  const prefix = normalizeExtractDir(extractDir);
  const files: ExtractedFile[] = [];

  let offset = 0;
  while (offset < unzipped.length) {
    const header = unzipped.subarray(offset, offset + 512);
    offset += 512;

    if (header.length < 512) break;

    const filename = header.toString('utf8', 0, 100).replace(/\0/g, '');
    if (!filename) break;

    const sizeStr = header.toString('utf8', 124, 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    // typeflag: '0' or NUL = regular file. Directories ('5'), symlinks ('2'),
    // pax headers ('x'/'g') etc. are skipped (dirs also have size 0).
    const typeflag = header[156];
    const isRegularFile = typeflag === 0x30 || typeflag === 0;

    if (size > 0 && isRegularFile && filename.startsWith(prefix)) {
      const relPath = filename.slice(prefix.length);
      if (relPath && !relPath.split('/').includes('..')) {
        files.push({ relPath, data: unzipped.subarray(offset, offset + size) });
      }
    }

    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;
  }

  return files.length > 0 ? files : null;
}

function extractFileFromTar(tarBuffer: Buffer, targetPath: string): Buffer | null {
  let offset = 0;

  while (offset < tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    if (header.length < 512) break;

    const filename = header.toString('utf8', 0, 100).replace(/\0/g, '');
    if (!filename) break;

    const sizeStr = header.toString('utf8', 124, 136).replace(/\0/g, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    if (size > 0 && filename === targetPath) {
      return tarBuffer.subarray(offset, offset + size);
    }

    const blocks = Math.ceil(size / 512);
    offset += blocks * 512;
  }

  return null;
}

// ─── PATH Management ───────────────────────────────────────────────────────

export function addToUserPath(dir: string): string {
  if (process.platform === 'win32') {
    return addToUserPathWindows(dir);
  }
  return addToUserPathUnix(dir);
}

function addToUserPathWindows(dir: string): string {
  let userPath = '';
  try {
    const regOut = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = regOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    userPath = match?.[1]?.trim() ?? '';
  } catch {
    // Registry key might not exist yet
  }

  const normDir = dir.replace(/[\\/]+$/, '').toLowerCase();
  const alreadyPresent = userPath.split(';').filter(Boolean).some(
    (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
  );
  if (alreadyPresent) {
    updateCurrentProcessPath(dir);
    return `${dir} already in user PATH`;
  }

  const newPath = userPath ? `${userPath};${dir}` : dir;

  // Strategy 1: PowerShell (no 1024-char limit)
  try {
    const psValue = newPath.replace(/'/g, "''");
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value '${psValue}'"`,
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    updateCurrentProcessPath(dir);
    return `Added ${dir} to user PATH (restart terminal to apply)`;
  } catch {
    // Fall through to setx
  }

  // Strategy 2: setx (1024-char limit)
  try {
    if (newPath.length <= 1024) {
      execSync(`setx PATH "${newPath}"`, {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      updateCurrentProcessPath(dir);
      return `Added ${dir} to user PATH (restart terminal to apply)`;
    }
    updateCurrentProcessPath(dir);
    return `PATH too long for automatic update (${newPath.length} > 1024). ` +
      `Please add ${dir} to your system PATH manually.`;
  } catch {
    // setx also failed
  }

  updateCurrentProcessPath(dir);
  return `Could not update PATH automatically. Add ${dir} to your system PATH manually.`;
}

function addToUserPathUnix(dir: string): string {
  const home = os.homedir();
  const shell = process.env['SHELL'] || '';

  let profileFile: string;
  if (shell.includes('zsh')) {
    profileFile = path.join(home, '.zshrc');
  } else if (shell.includes('bash')) {
    const bashrc = path.join(home, '.bashrc');
    profileFile = existsSync(bashrc) ? bashrc : path.join(home, '.profile');
  } else {
    const candidates = [
      path.join(home, '.bashrc'),
      path.join(home, '.zshrc'),
      path.join(home, '.profile'),
    ];
    profileFile = candidates.find((f) => existsSync(f)) ?? path.join(home, '.profile');
  }

  const exportLine = `export PATH="${dir}:$PATH"`;
  const marker = '# Added by Molio';

  try {
    if (existsSync(profileFile)) {
      const content = readFileSync(profileFile, 'utf8');
      if (content.includes(exportLine) || content.includes(marker)) {
        updateCurrentProcessPath(dir);
        return `${dir} already in ${profileFile}`;
      }
    }
    appendFileSync(profileFile, `\n${marker}\n${exportLine}\n`);
    updateCurrentProcessPath(dir);
    return `Added ${dir} to ${profileFile} (restart terminal to apply)`;
  } catch {
    updateCurrentProcessPath(dir);
    return `Could not update ${profileFile}. Add ${dir} to your PATH manually.`;
  }
}

/** @internal exported for testing */
export function updateCurrentProcessPath(dir: string): void {
  const pathKey = Object.keys(process.env).find(
    (k) => k.toUpperCase() === 'PATH',
  ) || 'PATH';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const current = (process.env[pathKey] || '') as string;
  const normDir = dir.replace(/[\\/]+$/, '').toLowerCase();
  const alreadyPresent = current.split(pathSep).some(
    (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
  );
  if (!alreadyPresent) {
    process.env[pathKey] = `${dir}${pathSep}${current}`;
  }
}
