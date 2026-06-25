import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function getConfigDir(): string {
  return path.join(os.homedir(), '.molio');
}
function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}
function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}
function getClaudeSettingsFile(): string {
  return path.join(getClaudeDir(), 'settings.json');
}
const CLAUDE_MANAGED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_MODEL',
]);

export interface AgentConfig {
  binaryPath?: string;
  env?: Record<string, string>;
}

export interface WeixinConfig {
  enabled?: boolean;
  baseUrl?: string;
  cdnBaseUrl?: string;
  credentialsPath?: string;
  defaultAgentId?: string;
  defaultCwd?: string;
}

export interface AppConfig {
  agents: Record<string, AgentConfig>;
  defaultCwd?: string;
  defaultAgentId?: string;
  locale?: string;
  weixin?: WeixinConfig;
}

const DEFAULT_CONFIG: AppConfig = {
  agents: {},
};

interface ClaudeSettingsFile {
  env?: Record<string, unknown>;
  [key: string]: unknown;
}

export function loadConfig(): AppConfig {
  try {
    const configFile = getConfigFile();
    if (!fs.existsSync(configFile)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(configFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      agents: { ...DEFAULT_CONFIG.agents, ...(parsed.agents || {}) },
    };
  } catch (err) {
    console.error('Failed to load config:', err);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  try {
    const configDir = getConfigDir();
    const configFile = getConfigFile();
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const tmpFile = configFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpFile, configFile);
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

/**
 * Merge a partial config update with the existing config.
 * Preserves agent and weixin configurations that are absent from the partial.
 */
export function mergeConfig(partial: Partial<AppConfig>): AppConfig {
  const existing = loadConfig();
  return {
    ...existing,
    ...partial,
    agents: {
      ...existing.agents,
      ...(partial.agents ?? {}),
    },
    weixin: partial.weixin !== undefined
      ? { ...(existing.weixin ?? {}), ...partial.weixin }
      : existing.weixin,
  };
}

export function getAgentConfig(agentId: string): AgentConfig {
  const config = loadConfig();
  const base = config.agents[agentId] || {};
  if (agentId !== 'claude') return base;

  const legacyEnv = pickClaudeManagedEnv(base.env);
  const claudeEnv = loadClaudeSettingsEnv();
  if (!claudeEnv && Object.keys(legacyEnv).length > 0) {
    tryMigrateClaudeEnv(config, legacyEnv);
  } else if (claudeEnv && Object.keys(legacyEnv).length > 0) {
    tryCleanupClaudeEnvFromMolioConfig(config);
  }

  const effectiveClaudeEnv = loadClaudeSettingsEnv() ?? legacyEnv;
  const localEnv = omitClaudeManagedEnv(base.env);
  if (Object.keys(effectiveClaudeEnv).length === 0) {
    return localEnv ? { ...base, env: localEnv } : { ...base, env: undefined };
  }

  return {
    ...base,
    env: {
      ...(localEnv ?? {}),
      ...effectiveClaudeEnv,
    },
  };
}

export function setAgentConfig(agentId: string, agentConfig: AgentConfig): void {
  const config = loadConfig();
  if (agentId === 'claude') {
    saveClaudeSettingsEnv(agentConfig.env ?? {});
    config.agents[agentId] = {
      ...agentConfig,
      env: omitClaudeManagedEnv(agentConfig.env),
    };
  } else {
    config.agents[agentId] = agentConfig;
  }
  saveConfig(config);
}

export function buildAgentEnv(agentId: string, agentConfig: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (agentConfig.env) Object.assign(env, agentConfig.env);
  if (agentConfig.binaryPath) {
    env[`${agentId.toUpperCase()}_BIN`] = agentConfig.binaryPath;
  }
  return env;
}

function loadClaudeSettingsEnv(): Record<string, string> | null {
  const settings = readJsonFile<ClaudeSettingsFile>(getClaudeSettingsFile());
  if (!settings?.env || typeof settings.env !== 'object') return null;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.env)) {
    if (!CLAUDE_MANAGED_ENV_KEYS.has(key)) continue;
    if (typeof value === 'string') env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : null;
}

function saveClaudeSettingsEnv(agentEnv: Record<string, string>): void {
  const claudeSettingsFile = getClaudeSettingsFile();
  const settings = readJsonFile<ClaudeSettingsFile>(claudeSettingsFile) ?? {};
  const existingEnv = settings.env && typeof settings.env === 'object'
    ? { ...settings.env }
    : {};

  for (const key of CLAUDE_MANAGED_ENV_KEYS) {
    delete existingEnv[key];
  }

  for (const [key, value] of Object.entries(agentEnv)) {
    if (!CLAUDE_MANAGED_ENV_KEYS.has(key)) continue;
    if (typeof value === 'string' && value.trim() !== '') {
      existingEnv[key] = value;
    }
  }

  const nextSettings: ClaudeSettingsFile = { ...settings };
  if (Object.keys(existingEnv).length > 0) {
    nextSettings.env = existingEnv;
  } else {
    delete nextSettings.env;
  }

  writeJsonFileAtomic(claudeSettingsFile, nextSettings, getClaudeDir());
}

function pickClaudeManagedEnv(env?: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!env) return picked;
  for (const [key, value] of Object.entries(env)) {
    if (CLAUDE_MANAGED_ENV_KEYS.has(key) && typeof value === 'string') {
      picked[key] = value;
    }
  }
  return picked;
}

function omitClaudeManagedEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const remaining: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!CLAUDE_MANAGED_ENV_KEYS.has(key) && typeof value === 'string') {
      remaining[key] = value;
    }
  }
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

function tryMigrateClaudeEnv(config: AppConfig, legacyEnv: Record<string, string>): void {
  try {
    saveClaudeSettingsEnv(legacyEnv);
    tryCleanupClaudeEnvFromMolioConfig(config);
  } catch (err) {
    console.warn('Failed to migrate Claude env to ~/.claude/settings.json:', err);
  }
}

function tryCleanupClaudeEnvFromMolioConfig(config: AppConfig): void {
  const current = config.agents['claude'];
  if (!current) return;
  const nextEnv = omitClaudeManagedEnv(current.env);
  const changed = Object.keys(pickClaudeManagedEnv(current.env)).length > 0;
  if (!changed) return;

  config.agents['claude'] = {
    ...current,
    env: nextEnv,
  };
  saveConfig(config);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(filePath: string, data: unknown, dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const tmpFile = filePath + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, filePath);
}
