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

  /**
   * Whether the agent supports interactive multi-turn conversations
   * (keeps stdin open between turns for follow-up messages).
   * When true, stdin is NOT closed after turn_end — it stays open
   * until cancelRun() or the child process exits naturally.
   */
  multiTurn?: boolean;

  fallbackModels: RuntimeModelOption[];

  env?: Record<string, string>;

  installUrl?: string;

  /**
   * When true, Molio can install this agent automatically via npm
   * (requires Node.js on the host). The install button replaces the
   * external install link in the Runtime page.
   */
  installable?: boolean;
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
  installable?: boolean;
}

// ─── Agent install events (SSE) ───

export interface InstallEvent {
  type: 'log' | 'done' | 'error' | 'node-check';
  message: string;
  exitCode?: number;
}
