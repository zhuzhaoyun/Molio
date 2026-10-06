import { execFileSync, execSync, spawn } from 'node:child_process';
import {
  mkdirSync, existsSync, chmodSync, writeFileSync, renameSync, unlinkSync,
  statSync, readFileSync, appendFileSync, rmSync,
} from 'node:fs';
import https from 'node:https';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import type {
  InstallEvent, InstallPhase, ErrorCategory,
  NpmNativeInstallSource, NpmJsInstallSource, RuntimeAgentDef,
} from '@molio/contracts';
import { validateBinary } from './launch.js';
import { getAgentDef } from './registry.js';

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
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Install an agent CLI. Reads install configuration from the agent definition
 * (data-driven) and dispatches to the appropriate install strategy.
 *
 * Currently supported strategies:
 * - `npm-native`: downloads pre-built native binaries from npm registry
 * - `npm-js`: runs a real `npm install` of a JS package (full dep tree),
 *   acquiring Node.js from the host or a downloaded portable build, then
 *   generates a shim that runs the package's bin entry through node.
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
  } else if (source.type === 'npm-js') {
    await installFromNpmJs(def, source, onEvent, signal);
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

// ─── npm-js Install Strategy ───────────────────────────────────────────────

/** Directory where portable Node.js builds are cached: ~/.molio/node/<version>/ */
function getMolioNodeRoot(): string {
  return path.join(os.homedir(), '.molio', 'node');
}

/** Directory where an npm-js runtime's dependency tree lives: ~/.molio/runtimes/<agentId>/ */
function getRuntimeRoot(agentId: string): string {
  return path.join(os.homedir(), '.molio', 'runtimes', agentId);
}

/** How a `npm` invocation is driven — host npm (via PATH) or managed node + npm-cli.js. */
export interface NpmRunner {
  cmd: string;
  baseArgs: string[];
  /** true only for host npm on Windows (npm.cmd needs cmd.exe to resolve). */
  shell: boolean;
}

/**
 * Absolute path to a portable Node build's `node` executable.
 * @internal exported for testing
 */
export function managedNodeBin(managedDir: string): string {
  return process.platform === 'win32'
    ? path.join(managedDir, 'node.exe')
    : path.join(managedDir, 'bin', 'node');
}

/**
 * Absolute path to a portable Node build's npm-cli.js (invoked via node).
 * @internal exported for testing
 */
export function managedNpmCli(managedDir: string): string {
  return process.platform === 'win32'
    ? path.join(managedDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(managedDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/**
 * Install a JS-package agent (e.g. DeepSeek Harness).
 *
 * Unlike npm-native (extract one pre-built binary), this runs a real
 * `npm install` of the package with its full dependency tree, then generates a
 * shim that runs the package's bin entry through a Node.js executable.
 *
 * Node acquisition is multi-tier:
 *  1. Host Node (>= minNodeMajor) + npm, probed via CHILD PROCESS — never
 *     process.version (the desktop daemon runs under ELECTRON_RUN_AS_NODE with
 *     an embedded Node that says nothing about the host environment).
 *  2. Otherwise a portable Node downloaded from managedNode.mirrors (in order),
 *     sha256-verified against the mirror's own SHASUMS256.txt, extracted, and
 *     atomically swapped into ~/.molio/node/<version>/.
 */
async function installFromNpmJs(
  def: RuntimeAgentDef,
  source: NpmJsInstallSource,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const agentName = def.name;
  const binName = def.install?.binName ?? def.bin;

  // ── Phase 1: Preflight — platform checks + host Node probe ──
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
  if (process.platform === 'win32' && def.install?.requirements?.minWindowsBuild) {
    const minBuild = def.install.requirements.minWindowsBuild;
    const build = getWindowsBuildNumber();
    if (build !== null && build < minBuild) {
      onEvent({
        type: 'error',
        message: `Windows version too old (build ${build}). ${agentName} requires build ${minBuild} or later.`,
        category: 'platform',
        retryable: false,
      });
      return;
    }
  }

  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }

  // Probe host node/npm. Never trust process.version (see NpmRunner docs).
  const host = probeHostNode(source.minNodeMajor, onEvent);
  let nodeBin: string;
  let runner: NpmRunner;

  if (host) {
    nodeBin = host.nodeBin;
    runner = { cmd: 'npm', baseArgs: [], shell: process.platform === 'win32' };
    onEvent({ type: 'log', message: `Using host Node ${host.version} at ${nodeBin}` });
  } else {
    // ── Phase 2: Download portable Node (managed mode) ──
    onEvent({ type: 'phase', phase: 'download', message: `Downloading portable Node ${source.managedNode.version}...` });
    let managedDir: string;
    try {
      managedDir = await ensureManagedNode(source, onEvent, signal);
    } catch (err) {
      if (signal?.aborted) {
        onEvent({ type: 'error', message: 'Installation cancelled during Node download', category: 'unknown', retryable: true });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const allNetwork = /mirror|download|sha|checksum|HTTP|network/i.test(msg);
      onEvent({
        type: 'error',
        message: `Failed to prepare portable Node.js: ${msg}`,
        category: allNetwork ? 'network' : 'platform',
        retryable: allNetwork,
        hint: allNetwork
          ? 'All Node.js mirrors failed. Check your network connection and try again.'
          : `Could not run a portable Node.js on this system. Install Node ${source.minNodeMajor}+ manually, then retry.`,
      });
      return;
    }
    nodeBin = managedNodeBin(managedDir);
    runner = { cmd: nodeBin, baseArgs: [managedNpmCli(managedDir)], shell: false };
    onEvent({ type: 'log', message: `Using portable Node ${source.managedNode.version} at ${nodeBin}` });
  }

  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }

  // ── Phase 3: npm install (reported under the 'extract' phase) ──
  const runtimeRoot = getRuntimeRoot(def.id);
  onEvent({
    type: 'phase',
    phase: 'extract',
    message: `Installing ${source.pkgName}@${source.version} (this may take a few minutes)...`,
  });

  try {
    mkdirSync(runtimeRoot, { recursive: true });
    const pkgJson = {
      name: `molio-runtime-${def.id}`,
      version: '1.0.0',
      private: true,
      dependencies: { [source.pkgName]: source.version },
    };
    writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8');
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to prepare install directory: ${err instanceof Error ? err.message : String(err)}`,
      category: 'permission',
      retryable: false,
      hint: `Check write permissions for ${runtimeRoot}`,
    });
    return;
  }

  const installFlags = ['--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
  const npmRes = await installNpmDeps(runner, source.registries, installFlags, runtimeRoot, onEvent, signal);
  if (npmRes.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled during npm install', category: 'unknown', retryable: true });
    return;
  }
  const { installed, lastFailure } = npmRes;

  if (signal?.aborted) {
    onEvent({ type: 'error', message: 'Installation cancelled', category: 'unknown', retryable: true });
    return;
  }
  if (!installed) {
    onEvent({
      type: 'error',
      message: `npm install failed for ${source.pkgName}@${source.version}. ${lastFailure}`.trim(),
      category: 'network',
      retryable: true,
      hint: 'Check your network connection and try again. If it persists, the package version may be unavailable on the configured registries.',
    });
    return;
  }

  // ── Phase 4: Validate — bin entry exists (JS has no ELF/PE header to check) ──
  onEvent({ type: 'phase', phase: 'validate', message: 'Verifying installed package...' });

  const binEntryPath = path.join(runtimeRoot, 'node_modules', ...source.pkgName.split('/'), ...source.binEntry.split('/'));
  if (!existsSync(binEntryPath)) {
    onEvent({
      type: 'error',
      message: `Package installed but bin entry not found: ${source.pkgName}/${source.binEntry}`,
      category: 'validation',
      retryable: false,
      hint: `The package layout may have changed. Try installing ${agentName} manually: ${def.installUrl ?? ''}`,
    });
    return;
  }

  // ── Phase 5: Test — run the bin entry through node ──
  onEvent({ type: 'phase', phase: 'test', message: 'Running version check...' });

  let installedVersion: string | undefined;
  try {
    const out = execFileSync(nodeBin, [binEntryPath, ...def.versionArgs], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    installedVersion = out.trim().split('\n')[0] ?? undefined;
    onEvent({ type: 'log', message: `Version check passed: ${installedVersion}` });
  } catch (err: any) {
    const detail = (err?.stderr?.toString?.() || err?.message || String(err)).trim().slice(0, 300);
    onEvent({
      type: 'error',
      message: `Installed package failed to run: ${detail}`,
      category: 'runtime',
      retryable: false,
      hint: `The package installed but cannot execute. This may indicate a Node.js version mismatch (requires >= ${source.minNodeMajor}). Manual install: ${def.installUrl ?? ''}`,
    });
    return;
  }

  // ── Phase 6: PATH — generate a shim in ~/.molio/bin and put it on PATH ──
  onEvent({ type: 'phase', phase: 'path', message: 'Configuring launcher and PATH...' });

  let shimPath: string;
  try {
    shimPath = writeShim(getMolioBinDir(), binName, nodeBin, binEntryPath);
  } catch (err) {
    onEvent({
      type: 'error',
      message: `Failed to write launcher shim: ${err instanceof Error ? err.message : String(err)}`,
      category: 'permission',
      retryable: false,
      hint: `Check write permissions for ${getMolioBinDir()}`,
    });
    return;
  }
  const pathMsg = addToUserPath(getMolioBinDir());
  onEvent({ type: 'log', message: pathMsg });

  // ── Done ──
  onEvent({
    type: 'done',
    message: `${agentName} installed successfully`,
    binaryPath: shimPath,
    version: installedVersion,
  });
}

/**
 * Probe the HOST environment for a usable Node.js + npm.
 *
 * CRITICAL: never read process.version — the desktop daemon runs under
 * ELECTRON_RUN_AS_NODE with an embedded Node that says nothing about whether
 * the user's machine has a real node/npm on PATH. Every check here spawns a
 * child process against the host environment.
 *
 * Returns null when node is missing, older than minMajor, or npm is absent —
 * the caller then falls back to a downloaded portable Node.
 *
 * @internal exported for testing
 */
export function probeHostNode(
  minMajor: number,
  onEvent: (event: InstallEvent) => void,
): { nodeBin: string; version: string } | null {
  try {
    const vOut = execFileSync('node', ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = vOut.match(/^v(\d+)\./);
    const major = m ? parseInt(m[1]!, 10) : NaN;
    if (!Number.isFinite(major) || major < minMajor) {
      onEvent({ type: 'log', message: `Host Node ${vOut || 'not found'} is below required v${minMajor} — downloading portable Node` });
      return null;
    }
    // npm present? On Windows npm is npm.cmd → needs a shell to resolve.
    execFileSync('npm', ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Absolute path to the host node executable (for the shim + test phase).
    const nodeBin = execFileSync('node', ['-e', 'process.stdout.write(process.execPath)'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!nodeBin || !existsSync(nodeBin)) return null;
    return { nodeBin, version: vOut };
  } catch {
    onEvent({ type: 'log', message: 'No suitable host Node/npm found — downloading portable Node' });
    return null;
  }
}

/** Injectable I/O for ensureManagedNode — tests fake the network + extraction. */
export interface ManagedNodeDeps {
  download?: (url: string, onEvent: (event: InstallEvent) => void, signal?: AbortSignal) => Promise<Buffer>;
  extract?: (archive: Buffer, ext: 'zip' | 'tar.gz', stagingDir: string) => Promise<void>;
}

/**
 * Ensure a portable Node build exists at ~/.molio/node/<version>/, downloading
 * + verifying + extracting it if absent. Returns the managed Node directory.
 * Idempotent: an existing valid install is reused without a network hit.
 *
 * @internal exported for testing (deps injection keeps tests network-free)
 */
export async function ensureManagedNode(
  source: NpmJsInstallSource,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
  deps: ManagedNodeDeps = {},
): Promise<string> {
  const download = deps.download ?? downloadOnce;
  const extract = deps.extract ?? extractNodeArchive;
  const { version, mirrors } = source.managedNode;
  const targetDir = path.join(getMolioNodeRoot(), version);
  const nodeBin = managedNodeBin(targetDir);
  const npmCli = managedNpmCli(targetDir);

  // Reuse an existing, complete portable install.
  if (existsSync(nodeBin) && existsSync(npmCli)) {
    onEvent({ type: 'log', message: `Portable Node ${version} already present — reusing` });
    return targetDir;
  }

  const { fileName, distName, ext } = nodeDistInfo(version);
  let lastErr = 'no mirrors configured';

  for (const mirror of mirrors) {
    if (signal?.aborted) throw new Error('Aborted');
    const base = `${mirror.replace(/\/+$/, '')}/${version}`;
    const host = mirror.replace(/^https?:\/\//, '').split('/')[0];
    try {
      onEvent({ type: 'log', message: `Downloading Node ${version} from ${host}...` });
      const archive = await download(`${base}/${fileName}`, onEvent, signal);
      if (signal?.aborted) throw new Error('Aborted');

      // Verify sha256 against the SAME mirror's SHASUMS256.txt.
      onEvent({ type: 'log', message: 'Verifying checksum...' });
      const shasums = (await download(`${base}/SHASUMS256.txt`, () => {}, signal)).toString('utf8');
      const expected = parseShaForFile(shasums, fileName);
      if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${fileName}`);
      const actual = sha256Hex(archive);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`sha256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
      }

      // Extract to a staging dir, then atomically swap into place.
      onEvent({ type: 'phase', phase: 'extract', message: 'Extracting portable Node...' });
      const stagingDir = `${targetDir}.staging-${Date.now()}`;
      rmSync(stagingDir, { recursive: true, force: true });
      mkdirSync(stagingDir, { recursive: true });
      try {
        await extract(archive, ext, stagingDir);
        const innerDir = path.join(stagingDir, distName);
        if (!existsSync(managedNodeBin(innerDir))) {
          throw new Error(`Extraction produced no node executable under ${distName}/`);
        }
        mkdirSync(getMolioNodeRoot(), { recursive: true });
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(innerDir, targetDir);
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }

      if (!existsSync(nodeBin) || !existsSync(npmCli)) {
        throw new Error('Portable Node extraction incomplete (missing node or npm-cli.js)');
      }
      onEvent({ type: 'log', message: `Portable Node ${version} installed to ${targetDir}` });
      return targetDir;
    } catch (err) {
      if (signal?.aborted) throw new Error('Aborted');
      lastErr = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'log', message: `Mirror ${host} failed (${lastErr}); trying next...` });
    }
  }

  throw new Error(`All Node.js mirrors failed. Last error: ${lastErr}`);
}

/**
 * Node.js distribution file naming for the current platform/arch.
 * @internal exported for testing
 */
export function nodeDistInfo(version: string): { fileName: string; distName: string; ext: 'zip' | 'tar.gz' } {
  const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  let arch: string = process.arch;
  if (arch === 'ia32') arch = 'x86';
  else if (arch === 'arm') arch = 'armv7l';
  const ext: 'zip' | 'tar.gz' = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const distName = `node-${version}-${osName}-${arch}`;
  return { fileName: `${distName}.${ext}`, distName, ext };
}

/**
 * Extract a Node distribution archive into stagingDir, producing
 * stagingDir/<distName>/... . Windows zips use PowerShell Expand-Archive
 * (built-in, native zip); Unix tarballs use system tar (preserves symlinks +
 * exec bits, which the in-memory tar parser does not).
 */
async function extractNodeArchive(
  archive: Buffer,
  ext: 'zip' | 'tar.gz',
  stagingDir: string,
): Promise<void> {
  if (ext === 'zip') {
    const zipPath = path.join(stagingDir, 'node-dist.zip');
    writeFileSync(zipPath, archive);
    const esc = (s: string) => s.replace(/'/g, "''");
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(stagingDir)}' -Force`,
    ], { encoding: 'utf8', timeout: 240_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    unlinkSync(zipPath);
  } else {
    const tarPath = path.join(stagingDir, 'node-dist.tar.gz');
    writeFileSync(tarPath, archive);
    // Unix absolute paths are safe with tar (the Windows drive-letter `host:path`
    // ambiguity does not apply here — this branch is non-Windows only).
    execFileSync('tar', ['-xzf', tarPath, '-C', stagingDir], {
      encoding: 'utf8',
      timeout: 240_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    unlinkSync(tarPath);
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Parse a `<sha256>  <filename>` line out of a SHASUMS256.txt body. */
export function parseShaForFile(shasums: string, fileName: string): string | null {
  for (const line of shasums.split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (m && m[2] === fileName) return m[1]!;
  }
  return null;
}

/**
 * Run an npm command via the given runner, streaming output and supporting
 * abort (SIGTERM on the child). Resolves with the exit code + captured output;
 * never rejects on non-zero exit (the caller decides). `aborted` distinguishes
 * a user cancel from a genuine failure. Emits a heartbeat log every ~20s so a
 * long, silent dependency install still shows liveness.
 */
function runNpm(
  runner: NpmRunner,
  args: string[],
  cwd: string,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runner.cmd, [...runner.baseArgs, ...args], {
      cwd,
      shell: runner.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const started = Date.now();
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      onEvent({ type: 'log', message: `Still installing dependencies... (${secs}s elapsed)` });
    }, 20_000);

    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(heartbeat);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr, aborted });
    });
  });
}

/**
 * Run `npm install` through the registry list, falling back to the next
 * registry on any non-zero exit. npm has no structured progress, so liveness
 * comes from runNpm's heartbeat logs. `aborted` distinguishes a user cancel
 * (SIGTERM'd child) from a genuine install failure.
 *
 * @internal exported for testing
 */
export async function installNpmDeps(
  runner: NpmRunner,
  registries: string[],
  installFlags: string[],
  cwd: string,
  onEvent: (event: InstallEvent) => void,
  signal?: AbortSignal,
): Promise<{ installed: boolean; lastFailure: string; aborted: boolean }> {
  let installed = false;
  let lastFailure = '';
  let aborted = false;
  for (const registry of registries) {
    if (signal?.aborted) { aborted = true; break; }
    onEvent({ type: 'log', message: `Installing dependencies from ${registry}...` });
    const res = await runNpm(
      runner,
      ['install', '--registry', registry, ...installFlags],
      cwd,
      onEvent,
      signal,
    );
    if (res.aborted) { aborted = true; break; }
    if (res.code === 0) {
      installed = true;
      break;
    }
    lastFailure = (res.stderr || res.stdout || '').trim().slice(-600);
    onEvent({ type: 'log', message: `Registry ${registry} failed (exit ${res.code}); trying next...` });
  }
  if (signal?.aborted) aborted = true;
  return { installed, lastFailure, aborted };
}

/**
 * Write a launcher shim into binDir that runs `<node> <binEntry> <args...>`.
 * All paths are quoted so spaces (Windows usernames, home dirs) are safe.
 * Windows → `<binName>.cmd` (%* forwards args); Unix → `<binName>` sh script
 * ("$@" forwards args) chmod 755.
 */
export function writeShim(
  binDir: string,
  binName: string,
  nodeBin: string,
  binEntryPath: string,
): string {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const shimPath = path.join(binDir, `${binName}.cmd`);
    writeFileSync(shimPath, `@echo off\r\n"${nodeBin}" "${binEntryPath}" %*\r\n`, 'utf8');
    return shimPath;
  }
  const shimPath = path.join(binDir, binName);
  writeFileSync(shimPath, `#!/bin/sh\nexec "${nodeBin}" "${binEntryPath}" "$@"\n`, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
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
