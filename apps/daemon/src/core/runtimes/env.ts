import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { TextDecoder as NodeTextDecoder } from 'node:util';
import type { RuntimeAgentDef } from '@molio/contracts';
import { detectNode } from './node-detect.js';

/**
 * Load a `.env` file and return key-value pairs.
 * Minimal parser — handles `KEY=VALUE` lines, ignores comments and blanks.
 */
function loadDotEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch {
    // File doesn't exist or unreadable — that's fine
  }
  return result;
}

/**
 * Resolve the config directory for an agent and load its `.env` file.
 * Convention: ~/.{agentId}/.env  (e.g. ~/.gemini/.env)
 */
function loadAgentDotEnv(agentId: string): Record<string, string> {
  const configDir = path.join(os.homedir(), `.${agentId}`);
  return loadDotEnv(path.join(configDir, '.env'));
}

export function buildSpawnEnv(
  def: RuntimeAgentDef,
  baseEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  // Priority: daemon config > parent process env > agent .env file
  const agentDotEnv = loadAgentDotEnv(def.id);
  const source = baseEnv ?? (process.env as Record<string, string>);
  const env: NodeJS.ProcessEnv = { ...agentDotEnv, ...source, ...(def.env ?? {}) };

  // Inject Molio runtime identity so the agent CLI knows which runtime
  // it is running as (e.g. when the user asks "which runtime is this?").
  env['MOLIO_AGENT_ID'] = def.id;
  env['MOLIO_AGENT_NAME'] = def.name;

  if (def.id === 'claude') {
    stripUnlessCustomBaseUrl(env, 'ANTHROPIC_BASE_URL', ['ANTHROPIC_API_KEY']);
    // Claude Code on Windows requires git-bash.
    // Auto-detect if CLAUDE_CODE_GIT_BASH_PATH is not already set.
    if (process.platform === 'win32' && !env['CLAUDE_CODE_GIT_BASH_PATH']) {
      const bashPath = findGitBash();
      if (bashPath) {
        env['CLAUDE_CODE_GIT_BASH_PATH'] = bashPath;
      }
    }
  }
  if (def.id === 'codex') {
    stripUnlessCustomBaseUrl(env, 'OPENAI_BASE_URL', ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  }

  // Ensure Node.js and npm-installed agent CLIs are in PATH.
  // Agent CLIs installed via npm create .cmd shims that call `node`,
  // which fails if node is not in PATH (common on systems with old/nvm Node.js).
  augmentPath(env);

  return env;
}

/**
 * Add Node.js and npm-installed binary directories to PATH.
 * This ensures that:
 * - `.cmd` shims (like `claude.cmd`) can find `node`
 * - npm-installed CLIs are accessible even if user hasn't restarted terminal
 * - The Molio user-level npm prefix (~/.molio/npm) is always searchable
 */
function augmentPath(env: NodeJS.ProcessEnv): void {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  // Normalize key — Windows env can use Path, PATH, or path
  const actualKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || pathKey;
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const currentPath = (env[actualKey] as string) || '';

  const dirsToAdd: string[] = [];
  const home = os.homedir();

  // 1. System Node.js directory (so `node` is available for .cmd shims)
  try {
    const nodeResult = detectNode();
    if (nodeResult.binary) {
      dirsToAdd.push(path.dirname(nodeResult.binary));
    }
    if (nodeResult.npmBinary) {
      dirsToAdd.push(path.dirname(nodeResult.npmBinary));
    }
  } catch { /* ignore */ }

  // 2. Molio user-level npm prefix (where `npm install --prefix` puts bins)
  if (process.platform === 'win32') {
    // On Windows, npm puts .cmd shims directly in the prefix dir
    dirsToAdd.push(path.join(home, '.molio', 'npm'));
    // Also add common npm global bin dirs
    dirsToAdd.push(path.join(home, 'AppData', 'Roaming', 'npm'));
  } else {
    dirsToAdd.push(path.join(home, '.molio', 'npm', 'bin'));
    dirsToAdd.push(path.join(home, '.local', 'bin'));
  }

  // Filter to dirs that exist and aren't already in PATH
  const newDirs = dirsToAdd.filter(d => {
    if (!fs.existsSync(d)) return false;
    return !currentPath.toLowerCase().includes(d.toLowerCase());
  });

  if (newDirs.length > 0) {
    env[actualKey] = `${newDirs.join(pathSep)}${pathSep}${currentPath}`;
  }
}

/**
 * Find git-bash (bash.exe) in common Windows installation directories.
 * Returns the full path to bash.exe, or null if not found.
 */
function findGitBash(): string | null {
  const candidates = [
    // Default Git for Windows install path
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    // Scoop / Chocolatey / portable installs
    path.join(process.env['USERPROFILE'] ?? '', 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    path.join(process.env['USERPROFILE'] ?? '', 'scoop', 'shims', 'git', 'bin', 'bash.exe'),
    'C:\\tools\\git\\bin\\bash.exe',
  ];

  // Also check any Git found in PATH
  const pathEnv = process.env['PATH'] ?? '';
  const pathDirs = pathEnv.split(';');
  for (const dir of pathDirs) {
    // Look for git.exe in PATH dirs, then resolve sibling bin/bash.exe
    const gitExe = path.join(dir, 'git.exe');
    if (fs.existsSync(gitExe)) {
      // git.exe is typically in cmd/ or bin/; bash.exe is in bin/
      const parent = path.dirname(dir);
      const bashCandidate = path.join(parent, 'bin', 'bash.exe');
      candidates.push(bashCandidate);
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore access errors
    }
  }
  return null;
}

function stripUnlessCustomBaseUrl(
  env: NodeJS.ProcessEnv,
  baseUrlKey: string,
  secretKeys: readonly string[],
): void {
  const baseUrlKeyUpper = baseUrlKey.toUpperCase();
  const hasCustomBaseUrl = Object.keys(env).some(
    (k) =>
      k.toUpperCase() === baseUrlKeyUpper
      && typeof env[k] === 'string'
      && (env[k] as string).trim() !== '',
  );
  if (hasCustomBaseUrl) return;

  const upper = new Set(secretKeys.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (upper.has(key.toUpperCase())) delete env[key];
  }
}

/* ── Windows console encoding ── */

let cachedCodePage: number | null = null;

/**
 * Detect the Windows console code page via `chcp`.
 * Returns 65001 (UTF-8) on non-Windows platforms or when detection fails.
 * Result is cached after the first call.
 */
export function detectWindowsCodePage(): number {
  if (process.platform !== 'win32') return 65001;
  if (cachedCodePage !== null) return cachedCodePage;

  try {
    const output = execSync('chcp', { encoding: 'utf8', timeout: 5000 });
    const match = output.match(/(\d+)/);
    cachedCodePage = match && match[1] ? parseInt(match[1], 10) : 65001;
  } catch {
    cachedCodePage = 65001;
  }
  return cachedCodePage;
}

/** Reset the cached code page (for testing). */
export function resetCodePageCache(): void {
  cachedCodePage = null;
}

/**
 * Map a Windows code page to a TextDecoder-compatible encoding label.
 */
function codePageToEncoding(cp: number): string {
  switch (cp) {
    case 65001: return 'utf-8';
    case 936:   return 'gbk';
    case 950:   return 'big5';
    case 932:   return 'shift_jis';
    case 949:   return 'euc-kr';
    case 1252:  return 'windows-1252';
    case 437:   return 'ibm437';
    default:    return 'utf-8';
  }
}

/**
 * Create a decoder for child process stderr on Windows.
 *
 * On non-Windows or when the code page is already UTF-8, returns null —
 * the caller should fall back to `setEncoding('utf8')`.
 *
 * On Windows with a non-UTF-8 code page (e.g. 936/GBK for Chinese),
 * returns a function that decodes raw Buffer chunks into properly
 * encoded strings via TextDecoder.
 */
export function createStderrDecoder(): ((buf: Buffer) => string) | null {
  if (process.platform !== 'win32') return null;

  const cp = detectWindowsCodePage();
  if (cp === 65001) return null;

  const encoding = codePageToEncoding(cp);
  let decoder: NodeTextDecoder;
  try {
    decoder = new NodeTextDecoder(encoding);
  } catch {
    return null; // Unknown encoding — fall back to UTF-8
  }

  return (buf: Buffer) => decoder.decode(buf, { stream: true });
}
