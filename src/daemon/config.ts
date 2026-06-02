import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.kge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface AgentConfig {
  /** Manual binary path override (e.g., /usr/local/bin/claude) */
  binaryPath?: string;
  /** Custom environment variables for this agent */
  env?: Record<string, string>;
}

export interface AppConfig {
  /** Per-agent configuration */
  agents: Record<string, AgentConfig>;
  /** Working directory for runs (defaults to homedir) */
  defaultCwd?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  agents: {},
};

/**
 * Load app config from ~/.kge/config.json
 * Returns default config if file doesn't exist.
 */
export function loadConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle missing fields
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

/**
 * Save app config to ~/.kge/config.json
 * Creates directory if needed.
 */
export function saveConfig(config: AppConfig): void {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    // Atomic write: write to temp file then rename
    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

/**
 * Get agent-specific config (binary path + env).
 */
export function getAgentConfig(agentId: string): AgentConfig {
  const config = loadConfig();
  return config.agents[agentId] || {};
}

/**
 * Set agent-specific config.
 */
export function setAgentConfig(agentId: string, agentConfig: AgentConfig): void {
  const config = loadConfig();
  config.agents[agentId] = agentConfig;
  saveConfig(config);
}

/**
 * Build environment for spawning, merging app config env with process env.
 */
export function buildAgentEnv(agentId: string, agentConfig: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy process.env (only strings)
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  // Merge agent-specific env
  if (agentConfig.env) {
    Object.assign(env, agentConfig.env);
  }

  // Apply binary path override
  if (agentConfig.binaryPath) {
    const envKey = `${agentId.toUpperCase()}_BIN`;
    env[envKey] = agentConfig.binaryPath;
  }

  return env;
}
