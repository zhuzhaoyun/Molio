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
      path.join(home, 'AppData', 'Local', 'pnpm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
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

export function probeVersion(bin: string, args: string[], timeoutMs = 5000): string | null {
  try {
    const needsShell = process.platform === 'win32' && (
      bin.endsWith('.cmd') || bin.endsWith('.bat')
    );

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
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: needsShell,
      env: { ...process.env, PATH: envPath },
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
