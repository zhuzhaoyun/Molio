import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RuntimeAgentDef } from '@molio/contracts';

const execFileAsync = promisify(execFile);

export interface ResolveOptions {
  configuredEnv?: Record<string, string>;
}

export interface ResolveResult {
  binary: string | null;
  source: 'env-override' | 'path' | 'well-known' | 'fallback-bin' | 'not-found';
}

/**
 * One resolved binary candidate, together with **where** it came from.
 * 探测按候选顺序试，第一个探测成功的即采用——见 resolveAgentBinaryCandidates。
 */
export interface BinaryCandidate {
  binary: string;
  source: ResolveResult['source'];
}

/**
 * 候选路径去重比较：Windows 上路径大小写不敏感。
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  return norm(a) === norm(b);
}

/**
 * 把路径包成 cmd.exe 命令行里安全的形式。
 *
 * **为什么必须加引号**：Windows 上 `.cmd`/`.bat` 只能由 cmd.exe 执行，Node 的
 * `shell: true` 会拼成 `cmd.exe /d /s /c "<binary> <args>"`。cmd 的 `/s` 会
 * 剥掉**最外层**那对引号，然后按第一个空格断词——于是
 * `C:\Program Files\nodejs\claude.cmd --version` 实际执行的是 `C:\Program`，
 * 报「'C:\Program' 不是内部或外部命令」。**任何带空格路径下的 shim 都会
 * 探测失败**，哪怕它背后的程序完好。
 *
 * 只用于 **binary 路径**——路径里不会出现 `"`，所以转义规则无关紧要。
 * **参数**的引号转义沿用原有的 `\"` 写法（见 quoteArgForCmd），不改成 cmd
 * 的 `""`：那条路径上有既存行为，不在本次修复范围内。
 */
export function quoteForCmd(p: string): string {
  return `"${p.replace(/"/g, '""')}"`;
}

/**
 * 参数加引号（沿用修复前的 `\"` 转义写法，保持既有行为不变）。
 *
 * cmd 的参数以空格分隔，不加引号会被拆成两个参数。
 */
export function quoteArgForCmd(a: string): string {
  return `"${a.replace(/"/g, '\\"')}"`;
}

/**
 * 组装一条给 `shell: true` 用的完整命令行：binary 路径加引号，含空格或
 * 引号的参数也加引号。
 */
export function shellCommandFor(bin: string, args: string[]): string {
  const quotedArgs = args.map((a) => (/[ "]/.test(a) ? quoteArgForCmd(a) : a));
  return [quoteForCmd(bin), ...quotedArgs].join(' ');
}

/**
 * 候选二进制的**有序列表**（去重）。
 *
 * 为什么要有列表而不是单个：Windows 上 `where claude` 的第一个命中常常是
 * 早年 npm 全局安装留下的 `.cmd` shim（`C:\Program Files\nodejs\claude.cmd`），
 * 而一键安装的健康副本在 `~/.molio/bin\claude.exe`。合成 PATH 时系统 PATH
 * 永远排在用户 PATH 之前，所以坏 shim 永远在前。若只取第一个候选且它探测
 * 失败，就直接判「未安装」，后面完好的二进制永远轮不到（见
 * docs/windows-runtime-detection-fix.md 的 Bug 2）。
 *
 * 优先级不变：env-override → PATH → well-known → fallbackBins（尊重用户自装
 * 版本）。列表里同一路径只出现一次。
 */
export function resolveAgentBinaryCandidates(
  def: RuntimeAgentDef,
  options: ResolveOptions = {},
): BinaryCandidate[] {
  const out: BinaryCandidate[] = [];
  const push = (binary: string | null, source: BinaryCandidate['source']) => {
    if (!binary) return;
    if (out.some((c) => samePath(c.binary, binary))) return;
    out.push({ binary, source });
  };

  // 1. Environment variable override
  const envKey = `${def.id.toUpperCase()}_BIN`;
  const envBin = options.configuredEnv?.[envKey] || process.env[envKey];
  if (envBin && fs.existsSync(envBin)) {
    push(envBin, 'env-override');
  }

  // 2. PATH lookup（全部命中，不只是第一个）
  for (const p of resolveOnPathCandidates(def.bin)) push(p, 'path');

  // 3. Well-known user toolchain directories
  for (const p of findInWellKnownDirsCandidates(def.bin)) push(p, 'well-known');

  // 4. Fallback binaries
  for (const fb of def.fallbackBins ?? []) {
    for (const p of resolveOnPathCandidates(fb)) push(p, 'fallback-bin');
    for (const p of findInWellKnownDirsCandidates(fb)) push(p, 'well-known');
  }

  return out;
}

/**
 * 取第一个候选——保持旧语义（不探测）。
 * 需要「探测失败就换下一个」时用 {@link resolveAgentBinaryCandidates}。
 */
export function resolveAgentBinary(
  def: RuntimeAgentDef,
  options: ResolveOptions = {},
): ResolveResult {
  const first = resolveAgentBinaryCandidates(def, options)[0];
  return first
    ? { binary: first.binary, source: first.source }
    : { binary: null, source: 'not-found' };
}

/** 探测函数的签名（同步版）。 */
export type ProbeFn = (bin: string, args: string[], timeoutMs?: number) => ProbeResult;

/** 探测函数的签名（异步版）。 */
export type ProbeFnAsync = (bin: string, args: string[], timeoutMs?: number) => Promise<ProbeResult>;

/** 候选探测的结果：选中哪个候选、版本是多少、失败原因是什么。 */
export interface CandidatePick {
  candidate: BinaryCandidate;
  version: string | null;
  error?: string;
}

/**
 * 依序探测候选，返回**第一个探测成功**的那个。
 *
 * 为什么不能只看第一个候选：Windows 上 `where claude` 的首个命中常常是
 * 早年 npm 全局安装留下的 `.cmd` shim，而一键安装的健康副本在
 * `~/.molio/bin\claude.exe`。合成 PATH 时系统 PATH 恒在用户 PATH 之前，
 * 坏 shim 永远在前——只探第一个就会把「shim 探测失败」误判成「未安装」，
 * 后面完好的二进制永远轮不到（见 docs/windows-runtime-detection-fix.md
 * 的 Bug 2）。
 *
 * 全部候选都失败时返回**第一个**候选连同它的错误（供 UI 诊断），
 * `version` 为 null——调用方据此判定为「不可用」。
 */
export function pickFirstWorkingCandidate(
  candidates: BinaryCandidate[],
  versionArgs: string[],
  probe: ProbeFn = probeVersion,
): CandidatePick | null {
  if (candidates.length === 0) return null;
  let firstFailure: ProbeResult | null = null;
  for (const candidate of candidates) {
    const result = probe(candidate.binary, versionArgs);
    if (result.version) {
      return { candidate, version: result.version };
    }
    if (!firstFailure) firstFailure = result;
  }
  return {
    candidate: candidates[0]!,
    version: null,
    error: firstFailure?.error ?? 'no usable binary found',
  };
}

/** Async twin of {@link pickFirstWorkingCandidate}. */
export async function pickFirstWorkingCandidateAsync(
  candidates: BinaryCandidate[],
  versionArgs: string[],
  probe: ProbeFnAsync = probeVersionAsync,
): Promise<CandidatePick | null> {
  if (candidates.length === 0) return null;
  let firstFailure: ProbeResult | null = null;
  for (const candidate of candidates) {
    const result = await probe(candidate.binary, versionArgs);
    if (result.version) {
      return { candidate, version: result.version };
    }
    if (!firstFailure) firstFailure = result;
  }
  return {
    candidate: candidates[0]!,
    version: null,
    error: firstFailure?.error ?? 'no usable binary found',
  };
}

/** Minimum expected size for a valid native binary (1 MB). */
const MIN_BINARY_SIZE = 1_024 * 1_024;
const MACHO_MAGICS = new Set([
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
]);

export function validateBinary(filePath: string, platform: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < MIN_BINARY_SIZE) {
      return `File too small (${stats.size} bytes, expected >= ${MIN_BINARY_SIZE})`;
    }

    // Windows shell scripts (.cmd, .bat) are text files, skip PE header check
    const ext = path.extname(filePath).toLowerCase();
    if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      return null;
    }

    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);

    if (platform === 'win32') {
      // PE files start with 'MZ' (DOS header)
      if (header[0] !== 0x4D || header[1] !== 0x5A) {
        return `Invalid PE header: ${header.toString('hex')}`;
      }
    } else {
      // ELF files start with 0x7f 'E' 'L' 'F'
      // Accept both byte orders for Mach-O and universal/fat headers.
      const magic = header.toString('hex');
      const isElf = magic === '7f454c46';
      const isMachO = MACHO_MAGICS.has(magic);
      if (!isElf && !isMachO) {
        return `Invalid ELF/Mach-O header: ${magic}`;
      }
    }

    return null; // valid
  } catch (err) {
    return `Validation error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * PATH 查找的**全部**命中（按 `where` 顺序），去重前保留原始次序。
 *
 * 旧实现只返回第一个可执行命中——Windows 上那常常是坏掉的 npm shim，
 * 后面的健康副本永远轮不到（见 docs/windows-runtime-detection-fix.md Bug 2）。
 */
function resolveOnPathCandidates(bin: string): string[] {
  if (process.platform === 'win32') {
    const whereCmds = [
      'C:\\Windows\\System32\\where.exe',
      'where.exe',
      'where',
    ];

    for (const cmd of whereCmds) {
      try {
        const result = execFileSync(cmd, [bin], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 3000,
        });
        if (result && result.trim().length > 0) {
          const lines = result.trim().split(/\r?\n/);
          const executableExts = ['.exe', '.cmd', '.bat'];
          const out: string[] = [];

          // 带可执行扩展名的优先（.exe / .cmd / .bat），按 where 顺序
          for (const line of lines) {
            const ext = path.extname(line).toLowerCase();
            if (executableExts.includes(ext) && fs.existsSync(line)) {
              out.push(line);
            }
          }
          // 再收无扩展名的（npm 在 Windows 上也会留一个无扩展名的 shim）
          for (const line of lines) {
            if (fs.existsSync(line)) {
              const cmdVersion = line + '.cmd';
              if (fs.existsSync(cmdVersion)) {
                out.push(cmdVersion);
              } else {
                out.push(line);
              }
            }
          }
          return out;
        }
      } catch {
        // try next
      }
    }
  } else {
    try {
      const result = execFileSync('which', ['-a', bin], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      if (result && result.trim().length > 0) {
        return result
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0 && fs.existsSync(line.trim()));
      }
    } catch {
      // not found
    }
  }
  return [];
}

/**
 * Async twin of {@link resolveOnPathCandidates} — replaces the `where.exe` /
 * `which` `execFileSync` spawns with promisified `execFile` so PATH lookups
 * for several agents can run concurrently without blocking the event loop.
 * Same candidate-filtering semantics as the sync variant.
 */
async function resolveOnPathCandidatesAsync(bin: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const whereCmds = [
      'C:\\Windows\\System32\\where.exe',
      'where.exe',
      'where',
    ];

    for (const cmd of whereCmds) {
      try {
        const { stdout } = await execFileAsync(cmd, [bin], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000,
        });
        if (stdout && stdout.trim().length > 0) {
          const lines = stdout.trim().split(/\r?\n/);
          const executableExts = ['.exe', '.cmd', '.bat'];
          const out: string[] = [];

          for (const line of lines) {
            const ext = path.extname(line).toLowerCase();
            if (executableExts.includes(ext) && fs.existsSync(line)) {
              out.push(line);
            }
          }

          for (const line of lines) {
            if (fs.existsSync(line)) {
              const cmdVersion = line + '.cmd';
              if (fs.existsSync(cmdVersion)) {
                out.push(cmdVersion);
              } else {
                out.push(line);
              }
            }
          }
          return out;
        }
      } catch {
        // try next
      }
    }
  } else {
    try {
      const { stdout } = await execFileAsync('which', ['-a', bin], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (stdout && stdout.trim().length > 0) {
        return stdout
          .trim()
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0 && fs.existsSync(line.trim()));
      }
    } catch {
      // not found
    }
  }
  return [];
}

/**
 * Async twin of {@link resolveAgentBinaryCandidates} — same candidate order
 * (env override → PATH → well-known dirs → fallback bins) and same
 * "keep every hit" semantics, but the PATH lookup spawns (`where.exe` /
 * `which`) are async. The well-known-dir scan stays sync fs.stat (cheap, no
 * subprocess).
 */
export async function resolveAgentBinaryCandidatesAsync(
  def: RuntimeAgentDef,
  options: ResolveOptions = {},
): Promise<BinaryCandidate[]> {
  const out: BinaryCandidate[] = [];
  const push = (binary: string | null, source: BinaryCandidate['source']) => {
    if (!binary) return;
    if (out.some((c) => samePath(c.binary, binary))) return;
    out.push({ binary, source });
  };

  // 1. Environment variable override
  const envKey = `${def.id.toUpperCase()}_BIN`;
  const envBin = options.configuredEnv?.[envKey] || process.env[envKey];
  if (envBin && fs.existsSync(envBin)) {
    push(envBin, 'env-override');
  }

  // 2. PATH lookup（全部命中）
  for (const p of await resolveOnPathCandidatesAsync(def.bin)) push(p, 'path');

  // 3. Well-known user toolchain directories
  for (const p of findInWellKnownDirsCandidates(def.bin)) push(p, 'well-known');

  // 4. Fallback binaries
  for (const fb of def.fallbackBins ?? []) {
    for (const p of await resolveOnPathCandidatesAsync(fb)) push(p, 'fallback-bin');
    for (const p of findInWellKnownDirsCandidates(fb)) push(p, 'well-known');
  }

  return out;
}

/**
 * Async twin of {@link resolveAgentBinary} — takes the first candidate
 * without probing. Use {@link resolveAgentBinaryCandidatesAsync} when you
 * need to fall through to the next candidate on probe failure.
 */
export async function resolveAgentBinaryAsync(
  def: RuntimeAgentDef,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const first = (await resolveAgentBinaryCandidatesAsync(def, options))[0];
  return first
    ? { binary: first.binary, source: first.source }
    : { binary: null, source: 'not-found' };
}

export function getWellKnownToolchainDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    dirs.push(
      // Molio user-level binary directory (one-click install target)
      path.join(home, '.molio', 'bin'),
      // Bundled-layout install target (agents whose binary needs sibling
      // resource files — e.g. Codex one-click install lands here)
      path.join(home, '.molio', 'bin', 'codex', 'bin'),
      path.join(home, 'AppData', 'Local', 'pnpm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
      // Hermes Agent — official PowerShell installer (iex ...) drops the venv
      // here: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes-acp.exe`
      // (VERIFIED on a real Windows install — this is the only resolution path
      // on Windows, there is no `~/.local/bin` shim fallback like on POSIX).
      // Resolving via well-known dir avoids depending on PATH propagation:
      // a daemon started before the installer updated PATH can't see the new
      // entry, since Windows processes inherit PATH as a startup snapshot.
      path.join(home, 'AppData', 'Local', 'hermes', 'hermes-agent', 'venv', 'Scripts'),
    );

    // nvm4w default symlink — always add as candidate; findInWellKnownDirs
    // guards with existsSync so non-existent dirs are harmless.
    dirs.push('C:\\nvm4w\\nodejs');
    const nvmHome = process.env['NVM_HOME'];
    if (nvmHome) dirs.push(nvmHome);
    const nvmSymlink = process.env['NVM_SYMLINK'];
    if (nvmSymlink) dirs.push(nvmSymlink);

    const nvmDir = path.join(home, 'AppData', 'Roaming', 'nvm');
    if (fs.existsSync(nvmDir)) {
      dirs.push(nvmDir);
      try {
        const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v'));
        for (const v of versions) dirs.push(path.join(nvmDir, v));
      } catch { /* ignore */ }
    }

    const fnmDir = path.join(home, 'AppData', 'Local', 'fnm');
    if (fs.existsSync(fnmDir)) {
      dirs.push(fnmDir);
      const fnmVersions = path.join(fnmDir, 'node-versions');
      if (fs.existsSync(fnmVersions)) {
        try {
          const versions = fs.readdirSync(fnmVersions).filter(v => v.startsWith('v'));
          for (const v of versions) dirs.push(path.join(fnmVersions, v, 'installation'));
        } catch { /* ignore */ }
      }
    }

    const voltaDir = path.join(home, 'AppData', 'Local', 'Volta', 'bin');
    if (fs.existsSync(voltaDir)) dirs.push(voltaDir);

    // WinGet (Windows Package Manager) — each package lives in its own subdirectory
    // e.g. AppData\Local\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_*
    const wingetDir = path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetDir)) {
      try {
        for (const entry of fs.readdirSync(wingetDir)) {
          const pkgDir = path.join(wingetDir, entry);
          if (fs.statSync(pkgDir).isDirectory()) dirs.push(pkgDir);
        }
      } catch { /* ignore */ }
    }
  } else {
    dirs.push(
      // Molio user-level binary directory (one-click install target)
      path.join(home, '.molio', 'bin'),
      // Bundled-layout install target (agents whose binary needs sibling
      // resource files — e.g. Codex one-click install lands here)
      path.join(home, '.molio', 'bin', 'codex', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.npm-packages', 'bin'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.volta', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      // Hermes Agent — the official install.sh (uv-based) puts the binary in a
      // `.hermes` venv: `~/.hermes/hermes-agent/.hermes/bin/hermes-acp` (observed
      // on a real macOS install; `~/.local/bin/hermes-acp` is a shim that execs
      // it, already covered above). The older `venv/bin` layout is kept as a
      // fallback since it is guarded by existsSync (harmless if absent).
      // Well-known resolution avoids depending on PATH propagation to an
      // already-running daemon. NOTE: the win32 twin uses `venv\Scripts` — that
      // layout was verified on a real Windows install and differs from POSIX.
      path.join(home, '.hermes', 'hermes-agent', '.hermes', 'bin'),
      path.join(home, '.hermes', 'hermes-agent', 'venv', 'bin'),
    );

    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v'));
        for (const v of versions) dirs.push(path.join(nvmDir, v, 'bin'));
      } catch { /* ignore */ }
    }

    const fnmDir = path.join(home, '.fnm', 'node-versions');
    if (fs.existsSync(fnmDir)) {
      try {
        const versions = fs.readdirSync(fnmDir).filter(v => v.startsWith('v'));
        for (const v of versions) dirs.push(path.join(fnmDir, v, 'installation', 'bin'));
      } catch { /* ignore */ }
    }

    dirs.push(
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.asdf', 'shims'),
    );
  }

  const npmPrefix = process.env['NPM_CONFIG_PREFIX'];
  if (npmPrefix) dirs.push(path.join(npmPrefix, 'bin'));

  return dirs;
}

function findInWellKnownDirsCandidates(bin: string): string[] {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const dirs = getWellKnownToolchainDirs();
  const out: string[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const candidate = path.join(dir, bin + ext);
    // Must be a regular file: bundled-layout installs (e.g. Codex) create a
    // directory at ~/.molio/bin/<agentId> that would otherwise shadow the
    // real binary in the later ~/.molio/bin/<agentId>/bin candidate dir.
    if (isRegularFile(candidate)) out.push(candidate);
    if (process.platform === 'win32') {
      const exeCandidate = path.join(dir, bin + '.exe');
      if (isRegularFile(exeCandidate)) out.push(exeCandidate);
    }
  }

  return out;
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ProbeResult {
  version: string | null;
  error?: string;
}

/**
 * On Windows, `.cmd`/`.bat` shims and extensionless POSIX-style shims cannot
 * be executed by Node's `execFile`/`spawn` directly — CreateProcess fails with
 * EINVAL or ENOENT because it only resolves `.exe` without PATHEXT lookup.
 * Such invocations need `shell: true` so cmd.exe resolves them via PATHEXT.
 *
 * Python venv creates an extensionless `hermes-acp` shim alongside the `.exe`
 * for Git Bash / MSYS compatibility. If `resolveOnPath` returns that shim
 * (e.g. the `.exe` was deleted, or `where` only surfaced the extensionless
 * entry), spawning without `shell: true` fails with ENOENT — the D8 root cause.
 *
 * Real `.exe` binaries don't need shell.
 */
export function needsShellOnWindows(binaryPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const lower = binaryPath.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return true;
  return path.extname(binaryPath) === '';
}

/**
 * Build the augmented PATH used by version probes: the binary's own dir plus
 * the well-known toolchain dirs, prepended only when missing from the current
 * PATH. Shared by the sync and async probe variants.
 */
function buildProbeEnvPath(bin: string): string {
  const extraDirs = [path.dirname(bin), ...getWellKnownToolchainDirs()];
  const currentPath = process.env['PATH'] || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const missingDirs = extraDirs.filter(d => !currentPath.includes(d));
  return missingDirs.length > 0
    ? `${missingDirs.join(pathSep)}${pathSep}${currentPath}`
    : currentPath;
}

export function probeVersion(bin: string, args: string[], timeoutMs = 5000): ProbeResult {
  try {
    const needsShell = needsShellOnWindows(bin);

    // 需要 shell 时必须把 binary 路径加引号：Node 拼成
    // `cmd.exe /d /s /c "<bin> <args>"`，cmd 的 /s 剥掉最外层引号后按第一个
    // 空格断词——`C:\Program Files\nodejs\claude.cmd` 会被执行成 `C:\Program`。
    // 见 docs/windows-runtime-detection-fix.md 的 Bug 1。
    const stdout = needsShell
      ? execFileSync(shellCommandFor(bin, args), {
          encoding: 'utf8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
          env: { ...process.env, PATH: buildProbeEnvPath(bin) },
        })
      : execFileSync(bin, args, {
          encoding: 'utf8',
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PATH: buildProbeEnvPath(bin) },
        });
    return { version: stdout.trim().split('\n')[0] ?? null };
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    return { version: null, error: msg };
  }
}

/**
 * Async twin of {@link probeVersion} — same semantics (never rejects: failures
 * come back as `{ version: null, error }`), but uses promisified `execFile` so
 * probing several agent CLIs doesn't freeze the daemon event loop. Cold CLI
 * starts (Claude Code on Windows: 1-3s each) used to serialize into a
 * multi-second full-process stall via the sync variant — the root cause of the
 * slow app boot (GET /api/agents blocking every other first-screen request).
 */
export async function probeVersionAsync(
  bin: string,
  args: string[],
  timeoutMs = 5000,
): Promise<ProbeResult> {
  try {
    const needsShell = needsShellOnWindows(bin);

    const { stdout } = needsShell
      ? await execFileAsync(shellCommandFor(bin, args), {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          shell: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, PATH: buildProbeEnvPath(bin) },
        })
      : await execFileAsync(bin, args, {
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, PATH: buildProbeEnvPath(bin) },
        });
    return { version: stdout.trim().split('\n')[0] ?? null };
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    return { version: null, error: msg };
  }
}
