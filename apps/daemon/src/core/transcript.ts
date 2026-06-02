/**
 * Transcript Builder — converts conversation history into a flat prompt string.
 * Ported from open-design's buildDaemonTranscript() in apps/web/src/providers/daemon.ts.
 *
 * Used for non-stream-json agents (codex, gemini, etc.) where each turn
 * is a fresh process spawn. The full conversation history is re-injected
 * as a transcript so the agent has context from prior turns.
 */

const MAX_TRANSCRIPT_MESSAGE_CHARS = 12_000;

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
}

/**
 * Build a flat transcript string from conversation history.
 * Format: "## user\n<message>\n\n## assistant\n<message>\n\n..."
 */
export function buildTranscript(
  history: TranscriptMessage[],
  targetAgentId?: string,
): string {
  if (!history || history.length === 0) return '';

  // Scope history to the target agent if switching agents mid-conversation
  const scoped = scopeHistoryToAgent(history, targetAgentId);

  const parts: string[] = [];

  // Add context warning if prior runs had large context
  const warning = buildPriorRunContextWarning(scoped);
  if (warning) parts.push(warning);

  // Build the transcript
  for (const msg of scoped) {
    const trimmed = msg.content.trim();
    if (!trimmed) continue;

    const sanitized = msg.role === 'assistant'
      ? sanitizePriorAssistantTurn(trimmed)
      : trimmed;

    const truncated = truncateForTranscript(sanitized);
    const escaped = escapeRoleDelimiters(truncated);

    parts.push(`## ${msg.role}\n${escaped}`);
  }

  return parts.join('\n\n');
}

/**
 * Scope history to messages from the target agent.
 * If we find a prior assistant message from a DIFFERENT agent,
 * discard everything before that point.
 */
function scopeHistoryToAgent(
  history: TranscriptMessage[],
  targetAgentId?: string,
): TranscriptMessage[] {
  if (!targetAgentId) return history;

  // Find the last assistant message from a different agent
  let cutoff = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === 'assistant' && msg.agentId && msg.agentId !== targetAgentId) {
      cutoff = i;
      break;
    }
  }

  if (cutoff >= 0) {
    return history.slice(cutoff + 1);
  }

  return history;
}

/**
 * Truncate a message to MAX_TRANSCRIPT_MESSAGE_CHARS.
 */
function truncateForTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_MESSAGE_CHARS) return text;

  const truncated = text.slice(0, MAX_TRANSCRIPT_MESSAGE_CHARS);
  return `${truncated}\n\n[... message truncated at ${MAX_TRANSCRIPT_MESSAGE_CHARS} chars, full content in persisted history ...]`;
}

/**
 * Sanitize prior assistant turns: strip tool cards, thinking blocks,
 * and other UI-only content that shouldn't be re-sent to the agent.
 */
function sanitizePriorAssistantTurn(text: string): string {
  // Strip <question-form> blocks (from AskUserQuestion tool)
  let cleaned = text.replace(/<question-form>[\s\S]*?<\/question-form>/g, '');

  // Strip ```json code blocks that look like tool schemas
  cleaned = cleaned.replace(/```json\s*\{[\s\S]*?"type"\s*:\s*"tool"[\s\S]*?\}\s*```/g, '');

  // Strip thinking blocks
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');

  // Strip tool result summaries
  cleaned = cleaned.replace(/\[Tool: \w+\].*?\[Result:.*?\]/gs, '');

  return cleaned.trim();
}

/**
 * Escape role delimiters in message content to prevent confusion
 * with the transcript structure.
 */
function escapeRoleDelimiters(text: string): string {
  // Replace "## user" or "## assistant" at the start of a line
  return text.replace(/^(#{1,2})\s*(user|assistant)\s*$/gm, '$1 $2 (quoted)');
}

/**
 * Build a context warning if prior messages were very long.
 */
function buildPriorRunContextWarning(history: TranscriptMessage[]): string | null {
  const totalChars = history.reduce((sum, msg) => sum + msg.content.length, 0);

  if (totalChars > 50_000) {
    return '[Note: This conversation has a large history. Prior messages may be truncated to fit context limits.]';
  }

  return null;
}
