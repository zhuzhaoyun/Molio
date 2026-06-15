import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RuntimeAgentDef } from '@molio/contracts';

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

  return env;
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
