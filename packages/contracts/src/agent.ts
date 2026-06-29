// ─── Runtime definition types ───

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export interface RuntimeBuildOptions {
  model?: string | null;
  /**
   * Path to a temp file whose contents are appended to the agent's built-in
   * system prompt (e.g. a wiki/vault role frame). For Claude Code this becomes
   * `--append-system-prompt-file <path>`. We pass a FILE path (not the text
   * inline) because the wiki frame is multi-KB with embedded quotes/backticks/
   * backslashes — passing it inline as `--append-system-prompt <text>` breaks
   * the CLI's argv parsing on Windows and silently eats subsequent flags
   * (notably `--dangerously-skip-permissions`), causing tool calls to be
   * blocked. A plain path arg has no such issue.
   */
  appendSystemPromptFile?: string;
}

export interface RuntimeContext {
  cwd?: string;
}

// ─── Install source configuration ───

/**
 * npm native binary package install source.
 * Downloads pre-built native binaries directly from npm registry (bypassing npm CLI).
 */
export interface NpmNativeInstallSource {
  type: 'npm-native';
  /** Version to install */
  version: string;
  /** Platform key → { npm package name, binary path inside tarball } */
  packages: Record<string, { pkgName: string; binInTar: string }>;
  /** Registry URLs to try in order (first success wins) */
  registries: string[];
}

/** Extensible install source union. Add new variants here for future agents. */
export type InstallSource = NpmNativeInstallSource;

/** Platform compatibility constraints for preflight checks. */
export interface PlatformRequirement {
  /** Minimum Windows build number (e.g. 17763 = Win10 1809). Ignored on non-Windows. */
  minWindowsBuild?: number;
  /** Explicit platform allowlist (e.g. ['win32-x64', 'darwin-arm64']). Empty = all allowed. */
  supportedPlatforms?: string[];
}

/** Install configuration block on an agent definition. */
export interface InstallConfig {
  source: InstallSource;
  requirements?: PlatformRequirement;
  /** Binary filename override (defaults to def.bin) */
  binName?: string;
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

  /** External install URL for manual install (shown when `install` is absent). */
  installUrl?: string;

  /**
   * Structured install configuration. When present, Molio can install
   * this agent automatically via the one-click install engine.
   * The install button replaces the external install link in the Runtime page.
   */
  install?: InstallConfig;
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
  /** Detailed error message when probeVersion failed (for diagnostics). */
  probeError?: string | null;
  models: RuntimeModelOption[];
  installUrl?: string;
  /** True when `def.install` is present (auto-install supported). */
  installable: boolean;
}

// ─── Agent install events (SSE) ───

export type InstallPhase = 'preflight' | 'download' | 'extract' | 'validate' | 'test' | 'path';

export type ErrorCategory =
  | 'platform'
  | 'network'
  | 'extraction'
  | 'validation'
  | 'permission'
  | 'runtime'
  | 'unknown';

export type InstallEvent =
  | { type: 'phase'; phase: InstallPhase; message: string }
  | { type: 'progress'; percent: number; downloadedBytes: number; totalBytes: number }
  | { type: 'log'; message: string }
  | { type: 'done'; message: string; binaryPath?: string; version?: string }
  | { type: 'error'; message: string; category: ErrorCategory; retryable: boolean; hint?: string };
