// ─── Runtime definition types ───

export interface RuntimeModelOption {
  id: string;
  label: string;
  /** 副行说明（来源/角色，如「Opus 映射 · glm-5.3-flash[1M]」）；缺省无副行。 */
  detail?: string;
}

export interface RuntimeBuildOptions {
  model?: string | null;
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
  /**
   * Version to install. Use `'latest'` to resolve `dist-tags.latest` from the
   * registry at install time.
   */
  version: string;
  /**
   * Used when `version` is `'latest'` but the registry lookup fails (e.g.
   * offline / registry unreachable). Should be a known-good version.
   */
  fallbackVersion?: string;
  /**
   * Platform key → { npm package name, binary path inside tarball }.
   *
   * - `tarballVersion`: tarball version template — `{version}` is replaced
   *   with the resolved version. Needed when platform builds are published
   *   as version-suffixed variants of ONE package instead of separate
   *   per-platform packages (e.g. `@openai/codex` publishes
   *   `0.149.0-win32-x64` → tarball `codex-0.149.0-win32-x64.tgz`).
   *   Omit when the version is used verbatim (the common case).
   * - `extractDir`: tar path prefix. When set, ALL regular files under the
   *   prefix are extracted into `<binDir>/<agentId>/` preserving relative
   *   paths (bundled layout — agents whose binary needs sibling resource
   *   files, e.g. Codex ships rg/sandbox helpers next to codex.exe).
   *   `binInTar` must lie inside `extractDir`. Omit for single-binary
   *   tarballs, which extract just `binInTar` into `<binDir>/`.
   */
  packages: Record<string, {
    pkgName: string;
    binInTar: string;
    tarballVersion?: string;
    extractDir?: string;
  }>;
  /** Registry URLs to try in order (first success wins) */
  registries: string[];
}

/**
 * Official installer script install source.
 * Downloads a platform-specific installer script (PowerShell / shell) and runs
 * it non-interactively. Unlike npm-native, the script manages its own download,
 * extraction, and PATH setup — Molio only orchestrates invocation, progress
 * streaming, and post-install verification. Used for agents that are not
 * distributed as npm native binaries (e.g. Hermes Agent, a Python source app
 * whose PyPI releases lag the upstream GitHub releases).
 */
export interface ScriptInstallSource {
  type: 'script';
  /**
   * Platform key → installer script URL. Keys match the `getPlatformKey()`
   * format (e.g. 'win32-x64', 'darwin-arm64'). `win32-*` entries must point
   * to a .ps1 script (run via powershell -File); all others must point to a
   * shell script (run via bash).
   */
  scripts: Record<string, string>;
  /**
   * Per-platform-family extra args appended to the script invocation.
   * Keys are matched by platform-key prefix ('win32' | 'darwin' | 'linux' | …)
   * with the special key 'posix' matching any non-win32 platform.
   * Platform-mandatory non-interactive flags (-NonInteractive / --non-interactive)
   * are added by the install engine automatically — don't repeat them here.
   */
  platformArgs?: Record<string, string[]>;
  /**
   * Max time (ms) to let the installer script run before killing it.
   * Source-installing agents can take several minutes (toolchain bootstrap,
   * dependency resolution). Default: 600_000 (10 min). When `stages` is set
   * this is a PER-STAGE budget (each stage run gets the full timeoutMs).
   */
  timeoutMs?: number;
  /**
   * Post-install verification: list of arg vectors passed to the resolved
   * binary in order; every invocation must exit 0. stdout of an invocation
   * containing '--version' is used as the installed version string.
   */
  verifyArgs?: string[][];
  /**
   * Ordered installer stage names. When set, the engine drives the installer
   * through its stage protocol — one script invocation per stage
   * (`-Stage NAME` on Windows / `--stage NAME` on POSIX) — instead of a single
   * full-ladder run, so it can inject work between stages (see
   * `mirrorLockfile`). Stages that need user input (e.g. setup/gateway) may be
   * listed for full-ladder parity: the engine's non-interactive flag makes the
   * installer skip them with exit 0.
   */
  stages?: string[];
  /**
   * CN-mirror rewrite hook for the installer's JSON lockfile (meaningful only
   * with `stages`). After `afterStage` completes — i.e. once the tool's repo
   * is on disk but before dependency/tool downloads start — the engine locates
   * `<home>/<relPath>` and rewrites download URLs to mirrors reachable on CN
   * networks (github.com → a probed GitHub-proxy prefix or the upstream
   * sha256-addressed asset mirror; nodejs.org/dist → npmmirror). Integrity is
   * anchored by the lockfile's own sha256 pins — the installer verifies every
   * downloaded byte — so a rewrite can never swap content, and a rewrite
   * failure is a logged warning, never an install failure.
   */
  mirrorLockfile?: {
    /** Stage after which the rewrite runs (typically the clone/checkout stage). */
    afterStage: string;
    /** Lockfile path relative to the tool's home directory. */
    relPath: string;
    /** Env var that overrides the home directory (the installer's own convention). */
    homeEnv?: string;
    /** Default home when homeEnv is unset. `~` and `%VAR%` are expanded. */
    defaultHome: { win32: string; posix: string };
  };
  /**
   * Git-config repair hook (meaningful only with `stages`). After `afterStage`
   * completes — the tool's repo is on disk but its post-clone maintenance has
   * not yet run — the engine edits `<home>/<repoRelPath>/.git/config` to stamp a
   * modern value over a legacy partial-clone filter.
   *
   * Why: some installers historically cloned with `--filter=tree:0` (treeless).
   * On the NEXT run the tool's own migration converts that to `blob:none` by
   * re-fetching the entire commit history (~100MB+ via `git fetch --refetch`),
   * which on slow/CN lines blows the per-stage timeout and wedges the install —
   * and because the migration only stamps the new filter on success, every retry
   * re-pays the full backfill. Stamping the modern value ourselves up-front
   * short-circuits the tool's migration gate. Fresh installs that already clone
   * with the modern filter are untouched.
   *
   * The edit is surgical (rewrites only the value of an EXISTING `key` inside
   * its section — never adds sections/keys), atomic (tmp+rename), idempotent,
   * and best-effort: a missing file/section/key, a value that already differs
   * from `fromValue`, or any IO error is a logged no-op, never a failure.
   */
  repairGitConfig?: {
    /** Stage after which the repair runs (typically the clone/checkout stage). */
    afterStage: string;
    /** Repo working-dir path relative to the tool's home; its `.git/config` is edited. */
    repoRelPath: string;
    /** Env var that overrides the home directory (the installer's own convention). */
    homeEnv?: string;
    /** Default home when homeEnv is unset. `~` and `%VAR%` are expanded. */
    defaultHome: { win32: string; posix: string };
    /**
     * Dotted git-config key to inspect/rewrite, e.g.
     * `remote.origin.partialclonefilter` → section `remote`, subsection `origin`,
     * key `partialclonefilter` (a `[remote "origin"]` header). A 2-part key
     * (`core.bare`) has no subsection.
     */
    key: string;
    /** Legacy value that triggers the repair (compared case-insensitively). */
    fromValue: string;
    /** Modern value stamped in its place (preserves the file's quoting style). */
    toValue: string;
  };
}

/**
 * npm JS package install source.
 *
 * Unlike `npm-native` (which extracts a pre-built native binary from a single
 * tarball), this strategy runs a real `npm install` of a JavaScript package
 * with its full dependency tree, then generates a shim script that runs the
 * package's bin entry through a Node.js executable.
 *
 * Node.js acquisition is multi-tier:
 * 1. Host Node (>= `minNodeMajor`) + npm, probed via child process — NEVER
 *    via `process.version` (the desktop daemon runs under ELECTRON_RUN_AS_NODE
 *    with an embedded Node that says nothing about the host environment).
 * 2. Otherwise a portable Node is downloaded from `managedNode.mirrors`
 *    (in order, first success wins) into `~/.molio/node/`, sha256-verified
 *    against the mirror's own SHASUMS256.txt, and atomically swapped into place.
 */
export interface NpmJsInstallSource {
  type: 'npm-js';
  /** npm package name, e.g. `'@deepseek-ai/dsh'`. */
  pkgName: string;
  /**
   * Exact version to install. MUST be a concrete semver — never `'latest'`.
   * Fast-moving packages (e.g. dsh developer previews) have had dist-tag
   * sync bugs; upgrades are deliberate code changes, tested before release.
   */
  version: string;
  /** Package bin entry relative to the package root, e.g. `'lib/bin.js'`. */
  binEntry: string;
  /** npm registry URLs to try in order (first success wins). */
  registries: string[];
  /** Minimum host Node.js major version required to run the package. */
  minNodeMajor: number;
  /** Portable Node fallback — downloaded when host Node is missing or too old. */
  managedNode: {
    /** Node version to download, e.g. `'v22.20.0'`. */
    version: string;
    /**
     * Mirror base URLs in priority order. Each mirror serves
     * `<base>/<version>/node-<version>-<platform>-<arch>.<ext>` and a
     * sibling `SHASUMS256.txt`. China-first ordering: aliyun-backed
     * npmmirror, then Tencent, then the official dist as last resort.
     */
    mirrors: string[];
  };
}

/** Extensible install source union. Add new variants here for future agents. */
export type InstallSource = NpmNativeInstallSource | ScriptInstallSource | NpmJsInstallSource;

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

  /**
   * Output stream format — used by selectParser to pick the right stream handler.
   * Required for 'stdio-jsonl' transport agents. Omit (or leave undefined) for
   * 'acp-jsonrpc' transport agents — their output is driven by AcpTransport,
   * not selectParser.
   */
  streamFormat?: string;
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

  /**
   * Transport mode: how Molio talks to the agent process.
   * - 'stdio-jsonl' (default): one-shot spawn, write prompt to stdin, parse JSONL from stdout.
   * - 'acp-jsonrpc': long-running JSON-RPC server (Agent Client Protocol). Spawn stays alive,
   *   multi-turn via session/prompt requests, events via session/update notifications.
   * When 'acp-jsonrpc', RunManager bypasses selectParser and drives an AcpTransport instead.
   */
  transport?: 'stdio-jsonl' | 'acp-jsonrpc';

  /**
   * ACP timeouts. Only meaningful when transport === 'acp-jsonrpc'.
   *
   * The actual JSON-RPC methods (`initialize`, `session/new`, `session/prompt`,
   * `session/cancel`) are hardcoded in RunManager — they're fixed by the ACP
   * spec, so there's no value in surfacing them as config.
   *
   * Timeouts are **activity-based**, not absolute: the idle timer resets on any
   * stdout/stderr output from the agent, so slow cold starts (MCP loading,
   * plugin discovery, provider connection) don't trip the timeout as long as
   * the agent is still printing progress. Only a truly hung agent (no output
   * for `idleTimeoutMs`) times out. An absolute safety-net cap is also enforced.
   *
   * The handshake phase (initialize + session/new) is chatty — the agent
   * prints progress throughout — so a short `idleTimeoutMs` catches true hangs
   * quickly. The prompt phase (session/prompt) is different: while waiting for
   * the LLM to respond, the agent can be **completely silent** for tens of
   * seconds (compiling system prompt, loading tool defs, waiting for first
   * token). `promptIdleTimeoutMs` is a longer idle timeout for that phase.
   */
  acp?: {
    /** Handshake idle (initialize + session/new) — agent is chatty, default 15s. */
    idleTimeoutMs?: number;
    /** Prompt-phase idle (session/prompt) — LLM latency, agent can be silent, default 60s. */
    promptIdleTimeoutMs?: number;
    /** Hard cap regardless of activity, as a safety net (default 300s = 5min). */
    absoluteTimeoutMs?: number;
    /** Timeout for `session/cancel` — strict absolute deadline (default 5s).
     *  On expiry, fall back to SIGTERM. Cancel is a short ack, no idle timer. */
    cancelTimeoutMs?: number;
    /**
     * Opt in to the pre-spawn integrity probe (`bin --check` + auto-repair of a
     * broken install). Only the hermes venv `[acp]`-extra repair flow uses
     * this. Other ACP agents MUST NOT set it: they don't implement `--check`
     * (dsh rejects unknown flags with "--profile <name> is required", exit 1),
     * so the probe would fail every run before the process is even spawned.
     */
    preflightRepair?: boolean;
    /**
     * Make the card's "Test" button run a real minimal LLM turn
     * ('Reply with exactly: "pong"' → wait for turn_end) instead of treating
     * the handshake alone as success. Required for agents whose session/new
     * succeeds WITHOUT credentials: dsh returns its model list (configOptions)
     * with no API key configured, so a handshake-only test shows green and the
     * user hits a missing-key wall on their first real message (observed on a
     * real machine, 2026-10-04). Leave unset where the handshake is a valid
     * install check and LLM latency would only make the test flaky (hermes).
     */
    testWithPrompt?: boolean;
  };

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
  /**
   * 「跟随默认」时 runtime 实际会用的默认模型（如 CC Switch 写入的
   * ANTHROPIC_MODEL）。仅当能从配置解析出来时才有值——供 UI 的
   * 「跟随默认」行显示「当前默认 xxx」副行。
   */
  defaultModel?: RuntimeModelOption;
  installUrl?: string;
  /** True when `def.install` is present (auto-install supported). */
  installable: boolean;
}

// ─── Agent install events (SSE) ───

/**
 * 'install' = running an installer script (ScriptInstallSource). Kept separate
 * from 'extract' so the UI shows a phase label + log stream instead of a
 * percentage progress bar (scripts don't report download percentages).
 */
export type InstallPhase = 'preflight' | 'download' | 'extract' | 'install' | 'validate' | 'test' | 'path';

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
