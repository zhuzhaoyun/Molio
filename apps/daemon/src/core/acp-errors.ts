/**
 * ACP init failure error formatting.
 *
 * When hermes-acp's venv is broken (missing Python module, missing
 * distribution), the raw error is a Python traceback that's meaningless to
 * non-developers. Detect known broken-install patterns in the last stderr
 * line and prepend an actionable "reinstall hermes-agent" hint, keeping the
 * technical detail for power users.
 *
 * Used by RunManager's ACP init catch handler — surfaces in both the chat
 * error event and the /api/agents/:id/test route's response, since the test
 * button just returns the run's `error` field.
 */

const INSTALL_URL = 'https://github.com/NousResearch/hermes-agent';

/**
 * Match Python import / distribution errors that indicate a broken venv:
 *   - "ModuleNotFoundError: No module named 'acp'"
 *   - "ImportError: No module named foo"
 *   - "ImportError: cannot import name 'X' from 'Y'"
 */
const MODULE_MISSING_RE =
  /^(?:ModuleNotFoundError|ImportError):\s+(?:No module named ['"]([^'"]+)['"]|cannot import name ['"]([^'"]+)['"])/;

/** Returns a friendly hint string if the stderr indicates a broken install, else null. */
export function detectBrokenInstallHint(lastStderr: string | undefined): string | null {
  if (!lastStderr) return null;
  const m = lastStderr.match(MODULE_MISSING_RE);
  if (!m) return null;
  const missing = m[1] ?? m[2] ?? 'unknown';
  return `hermes-agent 安装损坏（缺少 Python 模块 '${missing}'），请重装：${INSTALL_URL}`;
}

/**
 * Format the ACP init failure error message. If the last stderr line matches
 * a known broken-install pattern, prepend a friendly hint; otherwise keep
 * the raw error + last stderr (already useful for diagnosis).
 *
 * Always includes the binary path Molio spawned — when hermes works from
 * terminal but fails through Molio, the most common cause is Molio finding
 * a different (broken) install than `where hermes-acp` does. Surfacing the
 * path lets users compare immediately without digging through events.jsonl.
 */
export function formatAcpInitFailure(
  err: Error,
  lastStderr: string | undefined,
  binaryPath: string | undefined,
): string {
  const hint = detectBrokenInstallHint(lastStderr);
  const lastStderrSuffix = lastStderr ? ` (last stderr: "${lastStderr}")` : '';
  const binarySuffix = binaryPath ? ` [binary: ${binaryPath}]` : '';
  const raw = `ACP init failed: ${err.message}${lastStderrSuffix}${binarySuffix}`;
  return hint ? `${hint} — ${raw}` : raw;
}
