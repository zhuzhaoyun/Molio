import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InstallEvent } from '@molio/contracts';
import { detectNode } from './node-detect.js';

// npm package names for each installable agent
const AGENT_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
};

// Taobao npm mirror — used as fallback when the default registry times out
const TAOBAO_REGISTRY = 'https://registry.npmmirror.com';

/**
 * User-level npm prefix — used when global npm install fails due to
 * insufficient permissions (common on Windows without admin rights).
 * Packages installed here are found by launch.ts via getWellKnownToolchainDirs().
 */
export function getUserNpmPrefix(): string {
  return path.join(os.homedir(), '.molio', 'npm');
}

/**
 * Read the latest npm debug log from ~/.npm/_logs/.
 * npm writes full debug logs (named like 2024-01-15T12_34_56_789Z-debug-0.log)
 * when errors occur. These contain the complete error details that stderr truncates.
 * Returns null if no log directory exists or no log files are found.
 * @internal exported for testing
 */
export function readLatestNpmLog(): string | null {
  try {
    const logDir = path.join(os.homedir(), '.npm', '_logs');
    const entries = readdirSync(logDir);
    const logFiles = entries
      .filter(f => f.endsWith('-debug-0.log'))
      .sort()
      .reverse();

    if (logFiles.length === 0) return null;

    const logPath = path.join(logDir, logFiles[0]!);
    const content = readFileSync(logPath, 'utf8');

    // npm debug logs have lines like:
    //   "123 error code EACCES"
    //   "124 error syscall mkdir"
    //   "125 verbose ..."
    // Extract only the "error" lines — these contain the actual error
    // message, not the verbose lifecycle noise.
    const lines = content.split('\n');
    const errorLines = lines
      .filter(l => /\berror\b/i.test(l) && !/^\s*$/.test(l))
      .map(l => l.replace(/^\d+\s+/, ''))  // strip line number prefix
      .filter(l => l.trim().length > 0);

    if (errorLines.length > 0) {
      return errorLines.join('\n');
    }

    // Fallback: last 20 lines if no error lines found
    return lines.slice(-20).join('\n');
  } catch {
    return null;
  }
}

// Minimum Node.js version required by modern npm (npm v10 needs ^18.17.0 || >=20.5.0)
const MIN_NODE_MAJOR = 18;
const MIN_NODE_MINOR = 17;

/**
 * Parse "v18.17.0" → [18, 17, 0]. Returns null if not parseable.
 * @internal exported for testing
 */
export function parseNodeVersion(version: string): [number, number, number] | null {
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)];
}

/**
 * Check if a Node.js version is compatible with modern npm.
 * npm v10 requires ^18.17.0 || >=20.5.0.
 * @internal exported for testing
 */
export function isNodeVersionCompatible(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (major > 20) return true;
  if (major === 20 && minor >= 5) return true;
  if (major === 18 && minor >= 17) return true;
  return false;
}

/**
 * Locate the npm CLI script (npm-cli.js) relative to a node binary.
 * When using Electron's embedded Node.js, we can't call npm.cmd directly —
 * we need to run `node npm-cli.js install -g ...` instead.
 */
function resolveNpmCli(nodeBinary: string): string | null {
  const nodeDir = path.dirname(nodeBinary);
  const candidates = [
    // Standard npm installation: <prefix>/lib/node_modules/npm/bin/npm-cli.js
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Same directory
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Windows common paths
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Unix common paths
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface InstallOptions {
  agentId: string;
  onEvent: (event: InstallEvent) => void;
}

/**
 * Install an agent CLI via npm.
 * Emits SSE events for progress tracking:
 *   node-check → log (streaming) → done | error
 *
 * Error recovery:
 *   - Network timeout → retry with Taobao mirror
 *   - EEXIST conflict → retry with --force
 *   - EACCES permission → emit actionable error message
 */
export async function installAgent(opts: InstallOptions): Promise<void> {
  const { agentId, onEvent } = opts;

  const pkg = AGENT_PACKAGES[agentId];
  if (!pkg) {
    onEvent({ type: 'error', message: `No install package configured for agent: ${agentId}` });
    return;
  }

  // 1. Check Node.js
  onEvent({ type: 'node-check', message: 'Checking Node.js installation...' });
  const nodeResult = detectNode();

  // Determine which Node.js and npm to use
  let nodeBinary: string | null = null;
  let npmBin: string | null = null;
  let useElectronNode = false;

  if (nodeResult.available && nodeResult.npmAvailable && nodeResult.version) {
    if (isNodeVersionCompatible(nodeResult.version)) {
      // System Node.js is compatible — use it
      nodeBinary = nodeResult.binary!;
      npmBin = nodeResult.npmBinary!;
      onEvent({
        type: 'node-check',
        message: `Node.js ${nodeResult.version} found, npm at ${nodeResult.npmBinary}`,
      });
    } else {
      // System Node.js is too old — try Electron's embedded Node.js
      onEvent({
        type: 'node-check',
        message: `System Node.js ${nodeResult.version} is too old (need v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+), checking embedded runtime...`,
      });
      useElectronNode = true;
    }
  } else if (!nodeResult.available) {
    // No system Node.js at all — try Electron's embedded Node.js
    onEvent({
      type: 'node-check',
      message: 'System Node.js not found, checking embedded runtime...',
    });
    useElectronNode = true;
  } else {
    // Node.js found but npm missing
    onEvent({
      type: 'node-check',
      message: `Node.js ${nodeResult.version} found but npm is missing, checking embedded runtime...`,
    });
    useElectronNode = true;
  }

  if (useElectronNode) {
    // Try to use Electron's embedded Node.js (the daemon itself runs on it)
    const electronNode = resolveElectronNodeAndNpm();
    if (electronNode) {
      nodeBinary = electronNode.nodeBinary;
      npmBin = electronNode.npmCli;
      onEvent({
        type: 'node-check',
        message: `Using embedded Node.js ${electronNode.version} with bundled npm`,
      });
    } else {
      // Electron fallback not available — report error based on what we found
      if (nodeResult.available && nodeResult.version) {
        onEvent({
          type: 'error',
          message: `Node.js ${nodeResult.version} is too old for npm (requires v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+).\n` +
            'Please upgrade Node.js:\n' +
            '  Windows: winget install OpenJS.NodeJS.LTS\n' +
            '  macOS:   brew install node\n' +
            '  Linux:   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash - && sudo apt install nodejs',
        });
      } else {
        onEvent({
          type: 'error',
          message: 'Node.js is not installed and embedded runtime is unavailable.\n' +
            'Please install Node.js (v18+) first:\n' +
            '  Windows: winget install OpenJS.NodeJS.LTS\n' +
            '  macOS:   brew install node\n' +
            '  Linux:   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash - && sudo apt install nodejs',
        });
      }
      return;
    }
  }

  // 2. Run npm install
  const success = await runNpmInstall(nodeBinary!, npmBin!, pkg, onEvent, {
    registry: undefined,
    force: false,
    userPrefix: false,
  });

  if (success) {
    // 3. Verify and fix the installation.
    // npm may report success even if the postinstall script failed
    // (e.g. when `node` wasn't in PATH for `node install.cjs`).
    // The @anthropic-ai/claude-code package has a placeholder bin/claude.exe
    // that the postinstall replaces with the real native binary.
    // If the placeholder is still there, re-run install.cjs manually.
    onEvent({ type: 'log', message: 'Verifying installation...' });
    const fixed = await ensurePostinstallRan(pkg, nodeBinary!, npmBin!, onEvent);
    if (fixed) {
      onEvent({ type: 'done', message: `Successfully installed ${pkg}` });
    } else {
      onEvent({
        type: 'error',
        message: `${pkg} was downloaded but the native binary could not be set up.\n` +
          'The post-install script failed to place the platform-specific binary. ' +
          'Please install Node.js (v18+) on this system and try again.',
      });
    }
  }
}

/**
 * Ensure the postinstall script ran successfully.
 *
 * Some npm packages (like @anthropic-ai/claude-code) ship a placeholder binary
 * that the postinstall script replaces with the real native binary. If the
 * postinstall didn't run (node not in PATH, --ignore-scripts, etc.), the
 * placeholder remains and the CLI won't work.
 *
 * This function detects the placeholder and re-runs install.cjs manually
 * using the Electron-embedded Node.js.
 */
async function ensurePostinstallRan(
  pkg: string,
  nodeBinary: string,
  npmBin: string,
  onEvent: (event: InstallEvent) => void,
): Promise<boolean> {
  try {
    // Find the package's install directory
    const pkgDir = resolvePackageDir(pkg, npmBin);
    if (!pkgDir) {
      onEvent({ type: 'log', message: `Package directory for ${pkg} not found` });
      return false;
    }

    // Check if install.cjs exists
    const installScript = path.join(pkgDir, 'install.cjs');
    if (!existsSync(installScript)) {
      // No postinstall script — package doesn't need one
      onEvent({ type: 'log', message: 'No postinstall script, package is ready' });
      return true;
    }

    // Check if the binary is still a placeholder (< 4KB = stub)
    const binDir = path.join(pkgDir, 'bin');
    const binFiles = existsSync(binDir) ? readdirSync(binDir) : [];
    const placeholderDetected = binFiles.some(f => {
      const fp = path.join(binDir, f);
      try {
        const st = statSync(fp);
        return st.isFile() && st.size < 4096;
      } catch { return false; }
    });

    if (!placeholderDetected) {
      onEvent({ type: 'log', message: 'Native binary already in place' });
      return true;
    }

    // Re-run install.cjs with the available Node.js
    onEvent({ type: 'log', message: 'Running postinstall to set up native binary...' });

    const ok = await new Promise<boolean>((resolve) => {
      const isElectron = /electron/i.test(nodeBinary) || !!process.env['ELECTRON_RUN_AS_NODE'];
      const env = { ...process.env };
      if (isElectron) {
        env['ELECTRON_RUN_AS_NODE'] = '1';
      }

      const child = spawn(nodeBinary, [installScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
        timeout: 60000,
      });

      let stderr = '';
      child.stdout?.on('data', (c: Buffer) => {
        const text = c.toString('utf8').trim();
        if (text) onEvent({ type: 'log', message: text });
      });
      child.stderr?.on('data', (c: Buffer) => {
        const text = c.toString('utf8').trim();
        stderr += text + '\n';
        if (text) onEvent({ type: 'log', message: text });
      });
      child.on('error', (err) => {
        onEvent({ type: 'log', message: `Postinstall spawn error: ${err.message}` });
        resolve(false);
      });
      child.on('close', (code) => {
        if (code === 0) {
          onEvent({ type: 'log', message: 'Postinstall completed' });
          resolve(true);
        } else {
          onEvent({ type: 'log', message: `Postinstall exited with code ${code}` });
          resolve(false);
        }
      });
    });

    if (!ok) return false;

    // Verify the placeholder was replaced with a real binary
    const binFilesAfter = existsSync(binDir) ? readdirSync(binDir) : [];
    const hasRealBinary = binFilesAfter.some(f => {
      const fp = path.join(binDir, f);
      try {
        const st = statSync(fp);
        return st.isFile() && st.size > 4096; // Real binary is >>4KB
      } catch { return false; }
    });

    if (hasRealBinary) {
      onEvent({ type: 'log', message: 'Native binary installed successfully' });
      return true;
    }

    onEvent({ type: 'log', message: 'Postinstall ran but binary is still placeholder' });
    return false;
  } catch (err) {
    onEvent({ type: 'log', message: `Postinstall check error: ${err}` });
    return false;
  }
}

/**
 * Find the install directory of an npm package.
 * Checks common global npm prefix locations.
 */
function resolvePackageDir(pkg: string, npmBin: string): string | null {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', pkg),
      path.join(home, '.molio', 'npm', 'node_modules', pkg),
      'C:\\Program Files\\nodejs\\node_modules\\' + pkg,
    );
    // nvm4w
    const nvmSymlink = process.env['NVM_SYMLINK'];
    if (nvmSymlink) {
      candidates.push(path.join(nvmSymlink, 'node_modules', pkg));
    }
  } else {
    candidates.push(
      path.join(home, '.molio', 'npm', 'lib', 'node_modules', pkg),
      '/usr/lib/node_modules/' + pkg,
      '/usr/local/lib/node_modules/' + pkg,
      '/opt/homebrew/lib/node_modules/' + pkg,
    );
  }

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
  }
  return null;
}

/**
 * Resolve Electron's embedded Node.js and bundled npm for running npm install.
 * When the daemon runs inside Electron with ELECTRON_RUN_AS_NODE=1,
 * process.execPath is the Electron binary which acts as Node.js.
 * We also bundle npm's CLI script alongside the daemon.
 */
function resolveElectronNodeAndNpm(): { nodeBinary: string; npmCli: string; version: string } | null {
  const execPath = process.execPath;

  // Check if we're running under Electron
  if (!execPath || !existsSync(execPath)) return null;
  const isElectron = /electron/i.test(execPath) || !!process.env['ELECTRON_RUN_AS_NODE'];
  if (!isElectron) return null;

  // Find npm-cli.js bundled with the daemon resources
  const daemonDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const npmCliCandidates = [
    path.join(daemonDir, '..', 'npm', 'bin', 'npm-cli.js'),
    path.join(daemonDir, 'npm', 'bin', 'npm-cli.js'),
    path.join(daemonDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // System npm as last resort
    ...getSystemNpmCliCandidates(),
  ];

  let npmCli: string | null = null;
  for (const candidate of npmCliCandidates) {
    if (existsSync(candidate)) {
      npmCli = candidate;
      break;
    }
  }

  if (!npmCli) return null;

  // Get version
  let version = 'embedded';
  try {
    const stdout = execFileSync(execPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    version = stdout.trim().split('\n')[0] ?? 'embedded';
  } catch { /* ignore */ }

  return { nodeBinary: execPath, npmCli, version };
}

/** Common system paths for npm-cli.js */
function getSystemNpmCliCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );

    // nvm4w — npm is inside the symlink dir
    const nvmSymlink = process.env['NVM_SYMLINK'];
    if (nvmSymlink) {
      candidates.push(path.join(nvmSymlink, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
    candidates.push('C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js');

    // fnm
    const fnmDir = path.join(home, 'AppData', 'Local', 'fnm');
    if (existsSync(fnmDir)) {
      const fnmVersions = path.join(fnmDir, 'node-versions');
      if (existsSync(fnmVersions)) {
        try {
          const versions = readdirSync(fnmVersions).filter(v => v.startsWith('v')).sort().reverse();
          for (const v of versions) {
            candidates.push(path.join(fnmVersions, v, 'installation', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
          }
        } catch { /* ignore */ }
      }
    }

    // Molio npm prefix
    candidates.push(path.join(home, '.molio', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  } else {
    candidates.push(
      '/usr/lib/node_modules/npm/bin/npm-cli.js',
      '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
      path.join(home, '.nvm', 'versions', 'node'),  // will be expanded below
    );
  }

  // Expand nvm versions
  if (process.platform !== 'win32') {
    const nvmBase = path.join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmBase)) {
      try {
        const versions = readdirSync(nvmBase).filter(v => v.startsWith('v')).sort().reverse();
        for (const v of versions) {
          candidates.push(path.join(nvmBase, v, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        }
      } catch { /* ignore */ }
    }
  }

  return candidates;
}

/**
 * Create a temporary directory with a `node.cmd` wrapper that routes
 * `node` commands to Electron's embedded Node.js binary.
 *
 * On Windows, npm runs lifecycle scripts (postinstall) via
 * `cmd.exe /d /s /c node install.cjs`. If `node` is not in PATH,
 * this fails with "'node' is not recognized". Even when the system
 * has Node.js installed, it may not be in well-known directories
 * (e.g. nvm, custom install paths), so detectNode() can't find it.
 *
 * This function creates a temp directory with a `node.cmd` that
 * invokes the Electron binary with ELECTRON_RUN_AS_NODE=1, making
 * it behave as a standard Node.js runtime. Adding this directory
 * to PATH ensures npm lifecycle scripts always find `node`.
 *
 * Returns the shim directory path. Caller must clean up with rmSync.
 */
export function createNodeShim(nodeBinary: string): string {
  const shimDir = path.join(os.tmpdir(), 'molio-node-shim');
  mkdirSync(shimDir, { recursive: true });

  // node.cmd — wraps the Electron binary as a Node.js replacement.
  // %~dp0 = directory of this .cmd file (not used but standard prefix).
  // set ELECTRON_RUN_AS_NODE=1 makes Electron behave as plain Node.js.
  // Quotes around the binary path handle spaces (e.g. "C:\Program Files\...").
  const cmdContent = [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${nodeBinary}" %*`,
  ].join('\r\n');

  writeFileSync(path.join(shimDir, 'node.cmd'), cmdContent, 'utf8');

  return shimDir;
}

interface NpmOptions {
  registry?: string;
  force: boolean;
  /** Install to user-level prefix (~/.molio/npm) when global dir is not writable */
  userPrefix: boolean;
}

async function runNpmInstall(
  nodeBinary: string,
  npmBin: string,
  pkg: string,
  onEvent: (event: InstallEvent) => void,
  opts: NpmOptions,
): Promise<boolean> {
  // Determine spawn command:
  // - If npmBin is a .cmd/.bat file → spawn directly (shell: true on Windows)
  // - If npmBin is npm-cli.js → spawn as `node npm-cli.js install -g ...`
  const isNpmCli = npmBin.endsWith('npm-cli.js');
  const args = isNpmCli
    ? [npmBin, 'install', '-g', pkg]
    : ['install', '-g', pkg];

  if (opts.registry) {
    args.push('--registry', opts.registry);
  }
  if (opts.force) {
    args.push('--force');
  }
  if (opts.userPrefix) {
    const prefix = getUserNpmPrefix();
    mkdirSync(prefix, { recursive: true });
    args.push('--prefix', prefix);
  }

  const spawnBin = isNpmCli ? nodeBinary : npmBin;

  onEvent({
    type: 'log',
    message: isNpmCli
      ? `$ node npm-cli.js ${args.slice(1).join(' ')}`
      : `$ npm ${args.join(' ')}`,
  });

  // Build environment: when using Electron's Node.js, set ELECTRON_RUN_AS_NODE=1.
  // Also ensure `node` is in PATH so npm lifecycle scripts (e.g. `node install.cjs`
  // in @anthropic-ai/claude-code postinstall) can find it. Without this, npm
  // spawns cmd.exe to run `node`, which fails if node is not in PATH.
  //
  // We create a temp directory with a `node.cmd` wrapper that routes `node`
  // commands to the Electron binary. This is more reliable than trying to
  // find the system node (which may be in an unusual location or not in PATH).
  const env = { ...process.env };
  const useElectronNode = isNpmCli && /electron/i.test(nodeBinary);
  let shimDir: string | null = null;

  if (useElectronNode) {
    env['ELECTRON_RUN_AS_NODE'] = '1';
    // npm_config_node_execpath tells npm which node to use for lifecycle scripts.
    // Note: on Windows, npm does NOT use this for postinstall scripts run via
    // cmd.exe — it still looks for `node` in PATH. Hence the shim below.
    env['npm_config_node_execpath'] = nodeBinary;

    // Create a temp directory with node.cmd that wraps the Electron binary.
    // This ensures `node` is always findable in PATH for postinstall scripts,
    // regardless of whether the system has Node.js installed or in PATH.
    try {
      shimDir = createNodeShim(nodeBinary);
      const pathSep = process.platform === 'win32' ? ';' : ':';
      // Windows env keys are case-insensitive — find the actual key name
      // (could be Path, PATH, or path). If we create a new 'PATH' key
      // instead of updating the existing 'Path', cmd.exe won't see it.
      const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
      const currentPath = (env[pathKey] as string) || '';
      // Always prepend — our shim must take priority over system node
      env[pathKey] = `${shimDir}${pathSep}${currentPath}`;
    } catch {
      // If shim creation fails (disk full, permission), continue without it.
      // Postinstall may still fail, but at least npm install itself will run.
    }
  }

  return new Promise<boolean>((resolve) => {
    // Clean up the node shim directory when done
    const done = (result: boolean) => {
      if (shimDir) {
        try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const child = spawn(spawnBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Only use shell for .cmd files, not when running npm-cli.js through node
      shell: !isNpmCli && process.platform === 'win32',
      env,
    });

    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        // Split multi-line output into separate log events
        for (const line of text.split('\n')) {
          if (line.trim()) {
            onEvent({ type: 'log', message: line });
          }
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      stderr += text + '\n';
      if (text) {
        for (const line of text.split('\n')) {
          if (line.trim()) {
            onEvent({ type: 'log', message: line });
          }
        }
      }
    });

    child.on('error', (err) => {
      onEvent({ type: 'error', message: `Failed to start npm: ${err.message}` });
      done(false);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        done(true);
        return;
      }

      // Analyze the error and attempt recovery
      const errorInfo = analyzeNpmError(stderr);

      if (errorInfo.type === 'network' && !opts.registry) {
        // Network error → retry with Taobao mirror
        onEvent({
          type: 'log',
          message: 'Network error detected, retrying with npmmirror.com registry...',
        });
        const retryOk = await runNpmInstall(nodeBinary, npmBin, pkg, onEvent, {
          registry: TAOBAO_REGISTRY,
          force: opts.force,
          userPrefix: opts.userPrefix,
        });
        done(retryOk);
        return;
      }

      if (errorInfo.type === 'conflict' && !opts.force) {
        // EEXIST conflict → retry with --force
        onEvent({
          type: 'log',
          message: 'Existing installation detected, retrying with --force...',
        });
        const retryOk = await runNpmInstall(nodeBinary, npmBin, pkg, onEvent, {
          registry: opts.registry,
          force: true,
          userPrefix: opts.userPrefix,
        });
        done(retryOk);
        return;
      }

      if (errorInfo.type === 'permission' && !opts.userPrefix) {
        // Permission denied on global install → auto-retry with user-level prefix.
        // Installs to ~/.molio/npm/ which is always writable. launch.ts knows
        // to search this directory when looking for agent binaries.
        const prefix = getUserNpmPrefix();
        onEvent({
          type: 'log',
          message: `Global npm directory not writable, installing to user directory (${prefix})...`,
        });
        const retryOk = await runNpmInstall(nodeBinary, npmBin, pkg, onEvent, {
          registry: opts.registry,
          force: opts.force,
          userPrefix: true,
        });
        done(retryOk);
        return;
      }

      if (errorInfo.type === 'permission') {
        // Permission error even with user prefix — should not happen,
        // but provide a fallback message just in case.
        onEvent({
          type: 'error',
          message: 'Permission denied even in user directory. ' +
            'Please check disk space and try again.',
        });
        done(false);
        return;
      }

      // Generic failure — show the FIRST part of stderr where the actual
      // error message lives (the tail is usually just a stack trace).
      const firstLines = stderr.trim().split('\n').slice(0, 10).join('\n');
      const lastLines = stderr.trim().split('\n').slice(-5).join('\n');
      let detail = errorInfo.detail || `${firstLines}\n...\n${lastLines}`;

      // npm truncates errors in stderr (e.g. "ERROR: npm v10.9.0 is...").
      // Read the full debug log from ~/.npm/_logs/ for the complete picture.
      const npmLog = readLatestNpmLog();
      if (npmLog) {
        detail += '\n\n--- npm debug log (last 40 lines) ---\n' + npmLog;
      }

      onEvent({
        type: 'error',
        message: `npm install failed (exit code ${code}):\n${detail}`,
        exitCode: code ?? undefined,
      });
      done(false);
    });
  });
}

export interface NpmErrorInfo {
  type: 'network' | 'conflict' | 'permission' | 'unknown';
  detail?: string;
}

/** @internal exported for testing */
export function analyzeNpmError(stderr: string): NpmErrorInfo {
  const lower = stderr.toLowerCase();

  // Network errors
  if (
    lower.includes('enetunreachable') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('network') && lower.includes('error') ||
    lower.includes('fetcherror') ||
    lower.includes('requesterror') ||
    lower.includes('getaddrinfo')
  ) {
    return { type: 'network' };
  }

  // Permission errors — Windows and Unix
  if (
    lower.includes('eacces') ||
    lower.includes('permission denied') ||
    // Windows EPERM on global install (no admin rights)
    lower.includes('eperm') ||
    // Windows "access is denied" (file system)
    lower.includes('access is denied') ||
    // Windows UAC / admin required
    lower.includes('operation not permitted')
  ) {
    return { type: 'permission' };
  }

  // Conflict errors (existing installation)
  if (
    lower.includes('eexist') ||
    lower.includes('dest already exists')
  ) {
    return { type: 'conflict' };
  }

  // Extract the most useful lines: first non-empty lines (usually the
  // error name + message) rather than the tail (usually a stack trace).
  const lines = stderr.trim().split('\n').filter(l => l.trim());
  const usefulLines = lines.slice(0, 5);
  return { type: 'unknown', detail: usefulLines.join('\n') };
}
