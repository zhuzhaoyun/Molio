import type { RuntimeAgentDef } from '@molio/contracts';

export function buildSpawnEnv(
  def: RuntimeAgentDef,
  baseEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const source = baseEnv ?? (process.env as Record<string, string>);
  const env: NodeJS.ProcessEnv = { ...source, ...(def.env ?? {}) };

  // Inject Molio runtime identity so the agent CLI knows which runtime
  // it is running as (e.g. when the user asks "which runtime is this?").
  env['MOLIO_AGENT_ID'] = def.id;
  env['MOLIO_AGENT_NAME'] = def.name;

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
