import { spawn } from 'node:child_process';
import type { InstallEvent } from '@molio/contracts';
import { detectNode } from './node-detect.js';

// npm package names for each installable agent
const AGENT_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
};

// Taobao npm mirror — used as fallback when the default registry times out
const TAOBAO_REGISTRY = 'https://registry.npmmirror.com';

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

  if (!nodeResult.available) {
    onEvent({
      type: 'error',
      message: 'Node.js is not installed. Please install Node.js (v18+) first:\n' +
        '  Windows: winget install OpenJS.NodeJS.LTS\n' +
        '  macOS:   brew install node\n' +
        '  Linux:   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo bash - && sudo apt install nodejs',
    });
    return;
  }

  if (!nodeResult.npmAvailable) {
    onEvent({
      type: 'error',
      message: 'npm is not available. Node.js was found but npm is missing.\n' +
        `Node.js ${nodeResult.version} at ${nodeResult.binary}`,
    });
    return;
  }

  onEvent({
    type: 'node-check',
    message: `Node.js ${nodeResult.version} found, npm available at ${nodeResult.npmBinary}`,
  });

  // 2. Run npm install
  const npmBin = nodeResult.npmBinary!;
  const success = await runNpmInstall(npmBin, pkg, onEvent, { registry: undefined, force: false });

  if (success) {
    onEvent({ type: 'done', message: `Successfully installed ${pkg}` });
  }
}

interface NpmOptions {
  registry?: string;
  force: boolean;
}

async function runNpmInstall(
  npmBin: string,
  pkg: string,
  onEvent: (event: InstallEvent) => void,
  opts: NpmOptions,
): Promise<boolean> {
  const args = ['install', '-g', pkg];
  if (opts.registry) {
    args.push('--registry', opts.registry);
  }
  if (opts.force) {
    args.push('--force');
  }

  onEvent({
    type: 'log',
    message: `$ npm ${args.join(' ')}`,
  });

  return new Promise<boolean>((resolve) => {
    const child = spawn(npmBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // On Windows, .cmd files need shell: true
      shell: process.platform === 'win32',
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
      resolve(false);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        resolve(true);
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
        const retryOk = await runNpmInstall(npmBin, pkg, onEvent, {
          registry: TAOBAO_REGISTRY,
          force: opts.force,
        });
        resolve(retryOk);
        return;
      }

      if (errorInfo.type === 'conflict' && !opts.force) {
        // EEXIST conflict → retry with --force
        onEvent({
          type: 'log',
          message: 'Existing installation detected, retrying with --force...',
        });
        const retryOk = await runNpmInstall(npmBin, pkg, onEvent, {
          registry: opts.registry,
          force: true,
        });
        resolve(retryOk);
        return;
      }

      if (errorInfo.type === 'permission') {
        onEvent({
          type: 'error',
          message: 'Permission denied. Fix by running:\n' +
            '  npm config set prefix ~/.npm-global\n' +
            'Then add ~/.npm-global/bin to your PATH and retry.',
        });
        resolve(false);
        return;
      }

      // Generic failure
      onEvent({
        type: 'error',
        message: `npm install failed (exit code ${code}): ${errorInfo.detail || stderr.slice(-500)}`,
        exitCode: code ?? undefined,
      });
      resolve(false);
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

  // Permission errors
  if (
    lower.includes('eacces') ||
    lower.includes('permission denied') ||
    lower.includes('eperm') && lower.includes('mkdir')
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

  return { type: 'unknown', detail: stderr.trim().split('\n').slice(-3).join('\n') };
}
