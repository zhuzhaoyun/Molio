import type { RuntimeAgentDef } from '../types.js';

export function buildSpawnEnv(def: RuntimeAgentDef): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(def.env ?? {}) };

  if (def.id === 'claude') {
    stripUnlessCustomBaseUrl(env, 'ANTHROPIC_BASE_URL', ['ANTHROPIC_API_KEY']);
  }
  if (def.id === 'codex') {
    stripUnlessCustomBaseUrl(env, 'OPENAI_BASE_URL', ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  }

  return env;
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
