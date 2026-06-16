import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface NodeDetectResult {
  available: boolean;
  version?: string;
  npmAvailable: boolean;
  binary?: string;
  npmBinary?: string;
}

/**
 * Detect whether Node.js and npm are available on the system.
 * Reuses the well-known toolchain directory scan from launch.ts to handle
 * nvm/fnm/volta/asdf/mise installations.
 */
export function detectNode(): NodeDetectResult {
  const nodeBin = resolveBinary('node');
  if (!nodeBin) {
    return { available: false, npmAvailable: false };
  }

  const version = probeNodeVersion(nodeBin);
  const npmBin = resolveBinary('npm');

  return {
    available: true,
    version: version ?? undefined,
    npmAvailable: npmBin !== null,
    binary: nodeBin,
    npmBinary: npmBin ?? undefined,
  };
}

function probeNodeVersion(bin: string): string | null {
  try {
    const stdout = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a binary name to an absolute path.
 * Strategy: PATH lookup → well-known toolchain dirs.
 */
function resolveBinary(bin: string): string | null {
  // 1. PATH lookup
  const pathResult = resolveOnPath(bin);
  if (pathResult) return pathResult;

  // 2. Well-known toolchain directories
  return findInWellKnownDirs(bin);
}

function resolveOnPath(bin: string): string | null {
  if (process.platform === 'win32') {
    const whereCmds = ['C:\\Windows\\System32\\where.exe', 'where.exe', 'where'];
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
              if (fs.existsSync(cmdVersion)) return cmdVersion;
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

function getWellKnownToolchainDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    dirs.push(
      // Molio user-level npm prefix (auto-install fallback)
      path.join(home, '.molio', 'npm'),
      path.join(home, 'AppData', 'Local', 'pnpm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
    );

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
  } else {
    dirs.push(
      // Molio user-level npm prefix (auto-install fallback)
      path.join(home, '.molio', 'npm', 'bin'),
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
    if (fs.existsSync(candidate)) return candidate;
    if (process.platform === 'win32') {
      const exeCandidate = path.join(dir, bin + '.exe');
      if (fs.existsSync(exeCandidate)) return exeCandidate;
    }
  }

  return null;
}
