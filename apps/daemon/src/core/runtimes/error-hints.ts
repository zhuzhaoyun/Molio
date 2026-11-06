/**
 * Per-runtime error-message → Molio-actionable-hint mapping.
 *
 * Agent CLIs report configuration problems in their OWN vocabulary, pointing
 * at concepts that don't exist in Molio's UI. Non-technical users (Molio's
 * target audience) can't act on those messages. When a known pattern matches,
 * RunManager appends a hint that says exactly where to go in Molio to fix it.
 *
 * Rules:
 *  - The original error is ALWAYS preserved (diagnostics/bug reports); the
 *    hint is strictly additive.
 *  - Scoped per agentId: patterns are runtime-specific; applying them across
 *    runtimes risks false positives.
 *  - Match on the agent's own error text only — never pre-check credentials
 *    before spawn. Agents may hold credentials in their own stores that Molio
 *    knows nothing about (e.g. dsh's credentials service), so "no key in
 *    Molio config" does NOT imply "will fail"; only the agent's verdict does.
 */

interface HintRule {
  /** Tested against the raw error message from the agent. */
  match: RegExp;
  /** Actionable hint in Molio's words (UI is Chinese-first). */
  hint: string;
}

const RULES: Record<string, HintRule[]> = {
  dsh: [
    {
      // Real text (dsh 0.2.0-rc.2, surfaces as ACP -32603 on session/prompt):
      //   Internal error: turn failed: llm-deepseek: no API key for provider
      //   route "deepseek-official"; store DEEPSEEK_API_KEY through the
      //   credentials service (the web Models page writes it), or export
      //   DEEPSEEK_API_KEY in the launching environment
      //
      // "credentials service" and "the web Models page" are dsh-internal
      // concepts — in Molio the key lives in the provider config UI. The trap:
      // the dsh card's Test button only does the ACP handshake + session/new,
      // which succeed WITHOUT a key — so "Install → Test OK → first message"
      // lands the user straight in this error (observed on a real machine,
      // 2026-10-04). Keep matching on dsh's phrasing ("no API key"), not on
      // the provider-route detail, so custom-base-url routes are covered too.
      match: /no API key/i,
      hint:
        'DeepSeek API Key 未配置：请打开 Molio「设置 → 运行时 → DeepSeek Harness → 配置」，'
        + '粘贴你的 API Key（可在 https://platform.deepseek.com/api_keys 申请）并保存，'
        + '然后重新发送消息。',
    },
  ],
};

/**
 * Return the Molio-actionable hint for `message` produced by `agentId`, or
 * null when no rule matches. First matching rule wins.
 */
export function agentErrorHint(agentId: string, message: string): string | null {
  for (const rule of RULES[agentId] ?? []) {
    if (rule.match.test(message)) return rule.hint;
  }
  return null;
}
