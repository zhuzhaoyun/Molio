import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RuntimeAgentDef } from '@molio/contracts';

export interface ResolveOptions {
  configuredEnv?: Record<string, string>;
}

export interface ResolveResult {
  binary: string | null;
  source: 'env-override' | 'path' | 'well-known' | 'fallback-bin' | 'not-found';
}

export function resolveAgentBinary(
  def: RuntimeAgentDef,
  options: ResolveOptions = {},
): ResolveResult {
  // 1. Environment variable override
  const envKey = `${def.id.toUpperCase()}_BIN`;
  const envBin = options.configuredEnv?.[envKey] || process.env[envKey];
  if (envBin && fs.existsSync(envBin)) {
    return { binary: envBin, source: 'env-override' };
  }

  // 2. PATH lookup
  const pathResult = resolveOnPath(def.bin);
  if (pathResult) {
    return { binary: pathResult, source: 'path' };
  }

  // 3. Well-known user toolchain directories
  const wellKnownBin = findInWellKnownDirs(def.bin);
  if (wellKnownBin) {
    return { binary: wellKnownBin, source: 'well-known' };
  }

  // 4. Fallback binaries
  for (const fb of def.fallbackBins ?? []) {
    const fbPath = resolveOnPath(fb);
    if (fbPath) {
      return { binary: fbPath, source: 'fallback-bin' };
    }
    const fbWellKnown = findInWellKnownDirs(fb);
    if (fbWellKnown) {
      return { binary: fbWellKnown, source: 'well-known' };
    }
  }

  return { binary: null, source: 'not-found' };
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

function resolveOnPath(bin: string): string | null {
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

          for (const line of lines) {
            const ext = path.extname(line).toLowerCase();
            if (executableExts.includes(ext) && fs.existsSync(line)) {
              return line;
            }
          }

          for (const line of lines) {
            if (fs.existsSync(line)) {
              const cmdVersion = line + '.cmd';
              if (fs.existsSync(cmdVersion)) {
                return cmdVersion;
              }
              return line;
            }
          }
        }
      } catch {
        // try next
      }
    }
  } else {
    try {
      const result = execFileSync('which', [bin], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      if (result && result.trim().length > 0) {
        const firstLine = result.trim().split(/\r?\n/)[0];
        if (firstLine && fs.existsSync(firstLine)) {
          return firstLine;
        }
      }
    } catch {
      // not found
    }
  }
  return null;
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
      // here. Resolving via well-known dir avoids depending on PATH propagation:
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

function findInWellKnownDirs(bin: string): string | null {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const dirs = getWellKnownToolchainDirs();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const candidate = path.join(dir, bin + ext);
    // Must be a regular file: bundled-layout installs (e.g. Codex) create a
    // directory at ~/.molio/bin/<agentId> that would otherwise shadow the
    // real binary in the later ~/.molio/bin/<agentId>/bin candidate dir.
    if (isRegularFile(candidate)) return candidate;
    if (process.platform === 'win32') {
      const exeCandidate = path.join(dir, bin + '.exe');
      if (isRegularFile(exeCandidate)) return exeCandidate;
    }
  }

  return null;
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

export function probeVersion(bin: string, args: string[], timeoutMs = 5000): ProbeResult {
  try {
    const needsShell = needsShellOnWindows(bin);

    const extraDirs = [path.dirname(bin), ...getWellKnownToolchainDirs()];
    const currentPath = process.env['PATH'] || '';
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const missingDirs = extraDirs.filter(d => !currentPath.includes(d));
    const envPath = missingDirs.length > 0
      ? `${missingDirs.join(pathSep)}${pathSep}${currentPath}`
      : currentPath;

    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env, PATH: envPath },
    });
    return { version: stdout.trim().split('\n')[0] ?? null };
  } catch (err: any) {
    const msg = err?.stderr || err?.message || String(err);
    return { version: null, error: msg };
  }
}
