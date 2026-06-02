import { execFileSync } from 'node:child_process';
import type { RuntimeAgentDef } from '../types.js';

export function resolveAgentBinary(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): string | null {
  const envKey = `${def.id.toUpperCase()}_BIN`;
  const envBin = configuredEnv[envKey] || process.env[envKey];
  if (envBin) return envBin;

  if (isOnPath(def.bin)) return def.bin;

  for (const fb of def.fallbackBins ?? []) {
    if (isOnPath(fb)) return fb;
  }

  return null;
}

function isOnPath(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function probeVersion(
  bin: string,
  args: string[],
  timeoutMs = 5000,
): string | null {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
