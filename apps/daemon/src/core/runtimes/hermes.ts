import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { RuntimeAgentDef } from '@molio/contracts';
import { buildRepairErrorMessage, extractMissingModuleName } from '../acp-errors.js';
import { needsShellOnWindows } from './launch.js';

/**
 * Hermes Agent — Nous Research's self-improving AI agent.
 *
 * Unlike the other runtime defs here, Hermes does NOT use stdin-prompt + JSONL stdout.
 * It exposes a long-running JSON-RPC server (Agent Client Protocol) via the
 * `hermes-acp` console script. RunManager detects `transport: 'acp-jsonrpc'` and
 * drives it through AcpTransport instead of selectParser + stdin writes.
 *
 * Binary: `hermes-acp` (Windows: `hermes-acp.exe`, a venv shim created by the
 * official PowerShell iex installer). We deliberately do NOT fall back to the
 * `hermes` TUI binary — it doesn't speak ACP, and spawning it would hang the
 * handshake until the idle timeout fires. Users without `hermes-acp` on PATH
 * see a clean "not installed" state and can install via the installUrl below.
 *
 * Models: not passed via CLI args. `session/new` returns `models.availableModels`
 * dynamically; RunManager captures them and pushes to the frontend via SSE.
 * `fallbackModels` here is a static placeholder shown before the first run.
 */
export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes Agent',
  bin: 'hermes-acp',
  versionArgs: ['--version'],

  buildArgs: () => [],

  transport: 'acp-jsonrpc',
  acp: {
    // Handshake phase (initialize + session/new): hermes-acp is chatty —
    // prints MCP/plugin loading progress to stderr throughout. 15s of total
    // silence means the process is genuinely hung.
    idleTimeoutMs: 15000,
    // Prompt phase (session/prompt): the agent can be silent for a LONG time
    // in real workflows — not just first-token latency (system prompt compile,
    // tool def loading) but also while a TOOL runs. A subprocess-based tool
    // (OCR, doc conversion, web fetch) writes to its own stdout/stderr, not
    // hermes's, so hermes produces zero output until the tool returns. A
    // 50-page OCR can take 2-3 min; complex agentic loops can run 10+ min.
    // 5min idle catches truly dead sessions while not tripping on real tool
    // execution. Users with even longer workflows can override via
    // MOLIO_ACP_PROMPT_IDLE_TIMEOUT_MS env var.
    promptIdleTimeoutMs: 300000,
    // Safety-net cap: a session should never run this long. 30min accommodates
    // the longest agentic workflows (multi-step research, large doc processing)
    // while still guaranteeing an eventual exit. The idle timer catches hangs
    // much faster in normal operation.
    absoluteTimeoutMs: 1800000,
    cancelTimeoutMs: 5000,
  },

  // streamFormat left unset — ACP path bypasses selectParser entirely.
  multiTurn: true,

  fallbackModels: [
    { id: 'default', label: 'Default' },
  ],

  installUrl: 'https://github.com/NousResearch/hermes-agent',
};

// ─── Just-in-time [acp] extra auto-repair ───

/**
 * Version pin for the `agent-client-protocol` package. Mirrors the
 * `[acp]` extra declaration in hermes-agent's pyproject.toml. Bump when
 * NousResearch bumps.
 */
const ACP_PACKAGE_PIN = 'agent-client-protocol==0.9.0';

/** Name of the module the `[acp]` extra installs — the only breakage we auto-fix. */
const ACP_MODULE_NAME = 'acp';

/** Max time to let `hermes-acp --check` run before declaring it hung. */
const CHECK_TIMEOUT_MS = 15_000;

/** Max time for `pip install` into the venv (network-dependent). */
const PIP_INSTALL_TIMEOUT_MS = 120_000;

/** Custom error: the auto-repair path failed, message carries a copyable command. */
export class HermesRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesRepairError';
  }
}

export interface EnsureAcpExtraHooks {
  /** Called before each long-running step so RunManager can stream a status event. */
  onProgress?: (message: string) => void;
}

/** Internal subprocess result used by ensureAcpExtra + its deps for injection. */
export interface EnsureExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Test-injection seams for `ensureAcpExtra`. Production calls leave this
 * undefined and the real `execFile` / `spawn` / `fs.existsSync` are used.
 * Tests pass mocks to drive the state machine without spawning real
 * subprocesses — per CLAUDE.md integration-test rule, mock the behavior
 * (fail-then-recover, timeouts) rather than just return values.
 */
export interface EnsureAcpExtraDeps {
  runCheck?: (binaryPath: string) => Promise<EnsureExecResult>;
  runPipInstall?: (pythonExe: string, hooks: EnsureAcpExtraHooks | undefined) => Promise<EnsureExecResult>;
  resolveVenvPython?: (binaryPath: string) => string;
  existsSync?: (p: string) => boolean;
}

/**
 * Resolve the venv python that sits beside the `hermes-acp` shim. pip
 * console_scripts always live in `<venv>/Scripts/` (Windows) or `<venv>/bin/`
 * (POSIX), right next to the python executable. Windows uses `python.exe`,
 * POSIX uses `python`.
 */
export function resolveVenvPython(binaryPath: string): string {
  const dir = path.dirname(binaryPath);
  const exeName = process.platform === 'win32' ? 'python.exe' : 'python';
  return path.join(dir, exeName);
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runExecFile(
  binary: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
): Promise<ExecResult> {
  // On Windows, .cmd/.bat shims and extensionless POSIX shims must be spawned
  // with shell: true — see launch.ts:needsShellOnWindows. Without it, execFile
  // raises EINVAL/ENOENT and the check never runs. The production
  // hermes-acp.exe case has .exe and doesn't need shell, but test fixtures and
  // broken installs (extensionless shim only) do.
  const needsShell = needsShellOnWindows(binary);
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1 * 1024 * 1024,
        windowsHide: true,
        shell: needsShell,
        env: { ...process.env, ...extraEnv },
      },
      (err, stdout, stderr) => {
        const code = err ? (err as any).code ?? 1 : 0;
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
    // belt-and-suspenders: kill if still running past timeout
    child.on('error', () => resolve({ code: 1, stdout: '', stderr: 'spawn error' }));
  });
}

/** Run `<binary> --check` — hermes's own integrity probe (imports acp + server adapter). */
function runHermesCheck(binaryPath: string): Promise<ExecResult> {
  return runExecFile(binaryPath, ['--check'], CHECK_TIMEOUT_MS);
}

/**
 * Run `pip install` into the venv python. Streams stdout/stderr line-by-line
 * via the onProgress hook so the user sees live progress in the chat UI
 * (pip output is otherwise a wall of text the user never sees).
 */
async function runPipInstall(
  pythonExe: string,
  hooks: EnsureAcpExtraHooks | undefined,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(
      pythonExe,
      ['-m', 'pip', 'install', ACP_PACKAGE_PIN],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env },
      },
    );

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutRl = readline.createInterface({ input: child.stdout });
    const stderrRl = readline.createInterface({ input: child.stderr });
    stdoutRl.on('line', (line) => {
      stdoutLines.push(line);
      if (isProgressLine(line)) hooks?.onProgress?.(line);
    });
    stderrRl.on('line', (line) => {
      stderrLines.push(line);
      if (isProgressLine(line)) hooks?.onProgress?.(line);
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        code: 1,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n') + '\n[pip install timed out]',
      });
    }, PIP_INSTALL_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      stdoutRl.close();
      stderrRl.close();
      resolve({
        code: code ?? 1,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: 'spawn error' });
    });
  });
}

/** pip lines worth showing to the user (Collecting/Downloading/Installing/Successfully). */
function isProgressLine(line: string): boolean {
  return /^(Collecting|Downloading|Installing|Building|Successfully|Requirement already satisfied)/.test(
    line,
  );
}

/** Last non-empty line of a multiline stderr — Python tracebacks end with the actual error. */
function lastStderrLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * Verify hermes-acp's install integrity and auto-repair the one breakage we
 * can fix safely: missing `[acp]` extra (agent-client-protocol package).
 *
 * Runs `<binary> --check`. On success, returns silently. On failure, inspects
 * stderr for a missing-module pattern; if it's `acp`, runs
 * `<venv-python> -m pip install agent-client-protocol==0.9.0` and re-checks.
 *
 * Throws `HermesRepairError` when:
 *   - the missing module is NOT 'acp' (we don't auto-fix what we don't know)
 *   - the venv python can't be located (truly broken install — reinstall)
 *   - the pip install fails (network, permissions, etc.)
 *   - the re-check still fails after a successful install (something else)
 *
 * The thrown error message contains a fenced code block with a copyable
 * manual-fix command so RunManager's catch handler can surface it to the user.
 */
export async function ensureAcpExtra(
  binaryPath: string,
  hooks?: EnsureAcpExtraHooks,
  deps?: EnsureAcpExtraDeps,
): Promise<void> {
  const runCheck = deps?.runCheck ?? ((bin) => runExecFile(bin, ['--check'], CHECK_TIMEOUT_MS));
  const runPip = deps?.runPipInstall ?? runPipInstall;
  const resolvePython = deps?.resolveVenvPython ?? resolveVenvPython;
  const exists = deps?.existsSync ?? fs.existsSync;

  hooks?.onProgress?.('检查 Hermes 安装完整性...');

  const firstCheck = await runCheck(binaryPath);
  if (firstCheck.code === 0) return;

  const lastLine = lastStderrLine(firstCheck.stderr);
  const missingModule = extractMissingModuleName(lastLine);

  if (!missingModule) {
    // Non-import error (e.g. config issue, hermes-internal exception). Don't
    // auto-repair — surface the raw stderr so the user can diagnose.
    throw new HermesRepairError(
      buildRepairErrorMessage(
        'Hermes 安装检查失败（非模块缺失类错误），无法自动修复',
        resolvePython(binaryPath),
        firstCheck.stderr,
      ),
    );
  }

  if (missingModule !== ACP_MODULE_NAME) {
    // Missing some other module — not the [acp] extra case. Don't auto-fix.
    throw new HermesRepairError(
      buildRepairErrorMessage(
        `Hermes 安装损坏（缺少 Python 模块 '${missingModule}'），仅 'acp' 模块缺失支持自动修复`,
        resolvePython(binaryPath),
        firstCheck.stderr,
      ),
    );
  }

  const pythonExe = resolvePython(binaryPath);
  if (!exists(pythonExe)) {
    throw new HermesRepairError(
      `Hermes 安装损坏（缺少 [acp] extra），且未找到 venv python：${pythonExe}。请重新安装 hermes-agent：https://github.com/NousResearch/hermes-agent`,
    );
  }

  hooks?.onProgress?.('修复 Hermes 安装：安装 agent-client-protocol...');
  const install = await runPip(pythonExe, hooks);

  if (install.code !== 0) {
    throw new HermesRepairError(
      buildRepairErrorMessage(
        'Hermes 自动修复失败（pip install 出错）',
        pythonExe,
        install.stderr || install.stdout,
      ),
    );
  }

  hooks?.onProgress?.('验证 Hermes 安装...');
  const secondCheck = await runCheck(binaryPath);
  if (secondCheck.code === 0) return;

  throw new HermesRepairError(
    buildRepairErrorMessage(
      'Hermes 自动修复后安装检查仍失败（可能是其他依赖问题）',
      pythonExe,
      secondCheck.stderr,
    ),
  );
}
