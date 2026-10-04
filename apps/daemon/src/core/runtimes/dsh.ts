import type { RuntimeAgentDef } from '@molio/contracts';

/**
 * DeepSeek Harness (dsh) — DeepSeek's official agentic harness CLI
 * (`@deepseek-ai/dsh`, MIT).
 *
 * Spawned as `dsh --profile acp`, which turns dsh into a standard ACP v1
 * JSON-RPC server over stdio (PoC-verified 2026-10-04 on 0.2.0-rc.2):
 * initialize → protocolVersion 1, agentInfo "deepseek-harness-acp";
 * session/new works WITHOUT an API key and returns `configOptions` instead
 * of hermes-style `models.availableModels` — RunManager.initAcp parses both
 * shapes and emits the unified `models` event either way.
 *
 * Models: the `model` configOption is a grouped select whose option `value`
 * is a JSON-encoded [provider, model] tuple, e.g.
 * '["deepseek-official","deepseek-v4-pro"]'. initAcp matches the user's
 * selected model id against the tuple's model slug and applies it via
 * `session/set_config_option` right after session/new. 'default'/unset →
 * dsh's own default (currently deepseek-v4-flash) is left untouched.
 *
 * Permissions: dsh sends `session/request_permission` for sensitive
 * operations; AcpTransport auto-answers with the most permissive allow
 * option, consistent with the auto-approve posture of the other runtimes
 * (claude --dangerously-skip-permissions, codex danger-full-access on Win).
 *
 * Credentials: env-only (DEEPSEEK_API_KEY via the provider config UI; no
 * backing file), so env.ts deliberately has NO strip branch for dsh. The
 * handshake AND the card's Test button succeed without a key — the failure
 * only surfaces on the first real prompt, in dsh's own vocabulary
 * ("credentials service", "web Models page" — concepts Molio doesn't have).
 * runtimes/error-hints.ts maps that error to a Molio-actionable hint
 * (设置 → 运行时 → DeepSeek Harness → 配置). Real-machine observation,
 * 2026-10-04.
 *
 * Install: the first `npm-js` install source. dsh is a JS launcher package
 * (~90 @deepseek-ai/* deps) requiring host Node >= 22. The installer probes
 * host node/npm via CHILD PROCESS — never process.version, because the
 * desktop daemon runs under ELECTRON_RUN_AS_NODE with an embedded Node that
 * says nothing about the host environment. When host Node is missing or too
 * old, a portable Node v22.20.0 is downloaded from China-first mirrors
 * (aliyun npmmirror → Tencent → Huawei → nodejs.org, all verified reachable
 * on mainland networks), sha256-verified against the mirror's own
 * SHASUMS256.txt, then `npm install` runs with the pinned version and a
 * shim (`dsh.cmd` / `dsh`) lands in ~/.molio/bin.
 *
 * stderr: dsh prints non-fatal diagnostics ("dsh: warning: N entry did not
 * activate", plugin-activation ValidationErrors, Node experimental
 * warnings). RunManager.handleAcpStderr treats dsh stderr as `raw` unless a
 * line is an explicit error — escalating warnings to `error` events would
 * make the frontend set streaming:false and swallow the reply stream.
 */
export const dshAgentDef: RuntimeAgentDef = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  versionArgs: ['--version'],

  // Prompt never travels via CLI args on the ACP transport; the profile flag
  // selects the JSON-RPC stdio server personality.
  buildArgs: () => ['--profile', 'acp'],

  transport: 'acp-jsonrpc',
  acp: {
    // Same shape as hermes: the handshake is chatty (plugin activation
    // progress on stderr), while the prompt phase can go silent for a long
    // time (LLM first-token latency, long-running tools).
    //
    // 60s (not hermes's 15s) because the idle timer only resets on STDOUT
    // activity, and dsh's startup chatter goes to stderr. Measured on a real
    // Windows machine: the handshake right after one-click install (Defender
    // scanning the fresh ~90-package node_modules tree) took 27.8s — over the
    // 15s hermes-style window and uncomfortably close to 30s; warm launch is
    // 1.9s. "Install → Test" is exactly the flow a non-technical user hits
    // first, and slower machines can take twice as long, so the window is 60s.
    // A truly hung/crashed binary still fails fast via the exit handler.
    idleTimeoutMs: 60000,
    promptIdleTimeoutMs: 300000,
    absoluteTimeoutMs: 1800000,
    cancelTimeoutMs: 5000,
    // preflightRepair deliberately NOT set — `dsh --check` is not a valid
    // invocation (exits 1 with "--profile <name> is required"), so the
    // hermes-style venv repair probe must never run against this binary.

    // Test button must run a REAL minimal turn, not just the handshake:
    // dsh's session/new succeeds WITHOUT an API key (models come from local
    // configOptions), so a handshake-only test shows green while the first
    // real message fails "no API key for provider route" — the exact trap hit
    // on a real machine (2026-10-04). One tiny LLM call per Test click is a
    // fair price for "Test OK == actually usable".
    testWithPrompt: true,
  },

  multiTurn: true,

  // Silence dsh's telemetry plugin at the source. Only FEEDBACK_ONLY |
  // DISABLED are accepted ("OFF" produces a ValidationError warning at
  // activation). def.env is merged last in buildSpawnEnv, so this wins over
  // any stray host env value.
  env: {
    DSH_TELEMETRY_MODE: 'DISABLED',
  },

  // Ids are the tuple model slugs (option value = '["deepseek-official",<id>]')
  // so initAcp can match a user selection against configOptions; labels mirror
  // dsh's own display names. Shown before the first run — session/new's
  // configOptions replace this list dynamically via the `models` event.
  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
    { id: 'deepseek-flash', label: 'DeepSeek-V41-Flash' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
  ],

  installUrl: 'https://github.com/deepseek-ai/dsh',

  install: {
    source: {
      type: 'npm-js',
      pkgName: '@deepseek-ai/dsh',
      // Exact version pin — dsh is a fast-moving developer preview that has
      // had dist-tag sync bugs; upgrades are deliberate code changes, tested
      // before release. Never 'latest'.
      version: '0.2.0-rc.2',
      binEntry: 'lib/bin.js',
      // Mirror-first (mainland-China user base); official registry as
      // last-resort fallback.
      registries: [
        'https://registry.npmmirror.com',
        'https://registry.npmjs.org',
      ],
      minNodeMajor: 22,
      managedNode: {
        version: 'v22.20.0',
        // China-first ordering; npmmirror (aliyun OSS) and Tencent both
        // verified live (HTTP 200, ~34MB win-x64 zip + sibling
        // SHASUMS256.txt). Huawei as third candidate, official dist as the
        // last resort for users outside the GFW.
        mirrors: [
          'https://cdn.npmmirror.com/binaries/node',
          'https://mirrors.cloud.tencent.com/nodejs-release',
          'https://mirrors.huaweicloud.com/nodejs',
          'https://nodejs.org/dist',
        ],
      },
    },
  },
};
