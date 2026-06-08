import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.molio');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface AgentConfig {
  binaryPath?: string;
  env?: Record<string, string>;
}

export interface AppConfig {
  agents: Record<string, AgentConfig>;
  defaultCwd?: string;
  defaultAgentId?: string;
  locale?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  agents: {},
};

export function loadConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
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
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (err) {
    console.error('Failed to save config:', err);
    throw err;
  }
}

export function getAgentConfig(agentId: string): AgentConfig {
  const config = loadConfig();
  return config.agents[agentId] || {};
}

export function setAgentConfig(agentId: string, agentConfig: AgentConfig): void {
  const config = loadConfig();
  config.agents[agentId] = agentConfig;
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
