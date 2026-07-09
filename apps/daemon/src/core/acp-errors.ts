/**
 * ACP init failure error formatting.
 *
 * When hermes-acp's venv is broken (missing Python module, missing
 * distribution, version mismatch), the raw error is a Python traceback that's
 * meaningless to non-developers. Detect known broken-install patterns in the
 * last stderr line and prepend an actionable hint, keeping the technical
 * detail for power users.
 *
 * Pattern matching is table-driven (`ERROR_PATTERNS`) so new failure modes
 * are added by appending one entry — no more if/else patching (the 3 commits
 * a98d7c7/54ff9f2/f9465a7 each retroactively added a missing diagnostic
 * field; the table makes that linear).
 *
 * Used by RunManager's ACP init catch handler — surfaces in both the chat
 * error event and the /api/agents/:id/test route's response.
 */

const INSTALL_URL = 'https://github.com/NousResearch/hermes-agent';

type ErrorCategory =
  | 'missing_module'
  | 'missing_distribution'
  | 'runtime_crash'
  | 'config_error';

interface ErrorPattern {
  /** Anchor at start of line — stderr tail is the last line, so ^-anchored
   *  matches are precise and avoid false positives from mid-traceback noise. */
  regex: RegExp;
  category: ErrorCategory;
  /** Extract the relevant name (module, distribution, etc). null if the
   *  pattern has no name to extract. */
  extract?: (match: RegExpMatchArray) => string | null;
  /** Human-readable hint. If a function, receives the extracted name. */
  hint: string | ((extracted: string | null) => string);
}

/**
 * Table of known broken-install / runtime-crash patterns. Order matters only
 * for performance (first match wins); patterns are mutually exclusive on the
 * stderr shape they match.
 *
 * To add a new pattern: append an entry, add a test in acp-errors.test.ts.
 * Do NOT add a new if/else branch — that's the anti-pattern this refactor
 * eliminated.
 */
const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    // ModuleNotFoundError: No module named 'acp'
    // ImportError: No module named foo
    regex: /^(?:ModuleNotFoundError|ImportError):\s+No module named ['"]([^'"]+)['"]/,
    category: 'missing_module',
    extract: (m) => m[1] ?? null,
    hint: (name) =>
      `hermes-agent 安装损坏（缺少 Python 模块 '${name}'），请重装：${INSTALL_URL}`,
  },
  {
    // ImportError: cannot import name 'X' from 'Y'
    regex: /^ImportError:\s+cannot import name ['"]([^'"]+)['"]/,
    category: 'missing_module',
    extract: (m) => m[1] ?? null,
    hint: (name) =>
      `hermes-agent 安装损坏（无法导入 '${name}'），请重装：${INSTALL_URL}`,
  },
  {
    // pip "No matching distribution" — wrong Python version for the pinned
    // acp package, offline install, or a yanked release. Users see this when
    // auto-repair's `pip install agent-client-protocol==0.9.0` fails.
    regex: /^ERROR:\s+No matching distribution found for (.+)$/,
    category: 'missing_distribution',
    extract: (m) => m[1] ?? null,
    hint: (dist) =>
      `无法安装 '${dist}'（Python 版本不兼容或网络问题），请检查 venv Python 版本：${INSTALL_URL}`,
  },
  {
    // Python SyntaxError on startup — venv python is too old for hermes-acp's
    // syntax (e.g. 3.8 trying to run 3.11+ code). Surfaces as a top-level
    // SyntaxError in stderr when the acp module is imported.
    regex: /^SyntaxError:/,
    category: 'runtime_crash',
    hint: `hermes-acp 启动时报 SyntaxError（venv Python 版本可能过低），请升级 Python：${INSTALL_URL}`,
  },
];

interface ClassifiedError {
  category: ErrorCategory;
  extracted: string | null;
  hint: string;
}

/**
 * Classify a stderr tail line against the known pattern table. Returns null
 * when no pattern matches (e.g. INFO logs, unrecognized runtime exceptions) —
 * callers fall back to surfacing the raw stderr.
 */
function classifyStderr(lastStderr: string | undefined): ClassifiedError | null {
  if (!lastStderr) return null;
  for (const p of ERROR_PATTERNS) {
    const m = lastStderr.match(p.regex);
    if (m) {
      const extracted = p.extract ? p.extract(m) : null;
      return {
        category: p.category,
        extracted,
        hint: typeof p.hint === 'string' ? p.hint : p.hint(extracted),
      };
    }
  }
  return null;
}

/**
 * Extract the name of the missing Python module from a stderr line that
 * matches `ModuleNotFoundError` / `ImportError`. Returns `null` when the line
 * isn't a missing-module error.
 *
 * Reused by `ensureAcpExtra` (hermes.ts) to decide whether the breakage is the
 * one we know how to auto-repair (missing `acp` → missing `[acp]` extra →
 * missing `agent-client-protocol` package) vs. something to surface as an
 * error with a copyable fix command.
 */
export function extractMissingModuleName(lastStderr: string | undefined): string | null {
  const c = classifyStderr(lastStderr);
  if (c?.category === 'missing_module') return c.extracted;
  return null;
}

/** Returns a friendly hint string if the stderr indicates a broken install, else null. */
export function detectBrokenInstallHint(lastStderr: string | undefined): string | null {
  return classifyStderr(lastStderr)?.hint ?? null;
}

/**
 * Build the copyable manual-fix command for the case `ensureAcpExtra` handles:
 * `[acp]` extra is missing, auto-repair either was not attempted (missing
 * module wasn't `acp`) or failed (pip install / re-check errored).
 *
 * Windows uses the PowerShell call operator `& "..."` so users can paste it
 * directly into PowerShell; the python path is quoted to survive spaces in
 * `LOCALAPPDATA`. POSIX shells take the path raw (typical venv paths have no
 * spaces), still quoted for safety.
 */
export function buildManualPipCommand(pythonExe: string): string {
  if (process.platform === 'win32') {
    return `& "${pythonExe}" -m pip install agent-client-protocol==0.9.0`;
  }
  return `"${pythonExe}" -m pip install agent-client-protocol==0.9.0`;
}

/**
 * Build the error message thrown by `ensureAcpExtra` when auto-repair can't
 * complete. `prefix` is the human-readable lead-in, `stderr` is whatever
 * stderr came out of the last failed step, used here for the technical tail.
 *
 * The copyable command is emitted as a fenced code block so the web UI can
 * detect it and render a 复制 button. `formatAcpInitFailure` preserves the
 * block verbatim.
 */
export function buildRepairErrorMessage(
  prefix: string,
  pythonExe: string,
  stderr: string | undefined,
): string {
  const cmd = buildManualPipCommand(pythonExe);
  const stderrTail = stderr ? `\n\n最后 stderr：\n\`\`\`\n${stderr.trim()}\n\`\`\`` : '';
  return `${prefix}。请手动运行以下命令修复（hermes-agent venv）：

\`\`\`
${cmd}
\`\`\`${stderrTail}`;
}

/**
 * Format the ACP init failure error message.
 *
 * - If the error thrown by `ensureAcpExtra` already contains a fenced code
 *   block (copyable manual-fix command), preserve it verbatim and append the
 *   binary path for diagnosis.
 * - Otherwise, if the last stderr line matches a known broken-install pattern,
 *   prepend a friendly reinstall hint from the pattern table.
 * - Otherwise, keep the raw error + last stderr.
 *
 * Always includes the binary path Molio spawned — when hermes works from
 * terminal but fails through Molio, the most common cause is Molio finding a
 * different (broken) install than `where hermes-acp` does.
 */
export function formatAcpInitFailure(
  err: Error,
  lastStderr: string | undefined,
  binaryPath: string | undefined,
): string {
  const message = err.message;
  const binarySuffix = binaryPath ? ` [binary: ${binaryPath}]` : '';

  // `ensureAcpExtra` already formatted a copyable command block — pass it
  // through, only appending the binary path so users can compare installs.
  if (message.includes('```')) {
    return `${message}${binarySuffix}`;
  }

  const hint = detectBrokenInstallHint(lastStderr);
  const lastStderrSuffix = lastStderr ? ` (last stderr: "${lastStderr}")` : '';
  const raw = `ACP init failed: ${message}${lastStderrSuffix}${binarySuffix}`;
  return hint ? `${hint} — ${raw}` : raw;
}
