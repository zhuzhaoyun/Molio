// ─── Runtime definition types ───

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export interface RuntimeBuildOptions {
  model?: string | null;
}

export interface RuntimeContext {
  cwd?: string;
}

/**
 * The central abstraction. Every supported AI runtime is one object
 * conforming to this interface. Pure data + one function (buildArgs).
 */
export interface RuntimeAgentDef {
  id: string;
  name: string;
  bin: string;
  fallbackBins?: string[];
  versionArgs: string[];
  versionProbeTimeoutMs?: number;

  buildArgs: (
    prompt: string,
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];

  streamFormat: string;
  eventParser?: string;

  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';

  fallbackModels: RuntimeModelOption[];

  env?: Record<string, string>;

  installUrl?: string;
}

// ─── Agent detection result ───

export type AgentDetectSource = 'env-override' | 'path' | 'well-known' | 'fallback-bin' | 'not-found';

export interface AgentInfo {
  id: string;
  name: string;
  available: boolean;
  binary?: string | null;
  source?: AgentDetectSource;
  version?: string | null;
  models: RuntimeModelOption[];
  installUrl?: string;
}
