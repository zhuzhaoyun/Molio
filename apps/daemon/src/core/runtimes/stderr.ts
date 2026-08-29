import type { AgentEvent } from '@molio/contracts';

/**
 * Classify a stderr chunk from a stdio-jsonl agent process into the AgentEvents
 * Molio should emit. Returns an empty array when the chunk carries nothing
 * actionable.
 *
 * Why not "every stderr line is an error": agent CLIs write informational
 * diagnostics to stderr too. Two known cases:
 *
 * 1. Codex CLI logs "Reading prompt from stdin..." / "Reading additional input
 *    from stdin..." on every run — pure info, must not surface.
 *
 * 2. Claude Code (>= 2.1.233) writes `[claude-code:<kind>]` diagnostics to
 *    stderr in print mode. `[claude-code:unrecognized_model]` fires on EVERY
 *    request whose model id isn't a built-in Anthropic id — which is always
 *    the case for third-party providers (DeepSeek, OpenRouter, ...). The
 *    request still goes out; the line is informational (Claude Code docs tell
 *    harnesses reading stderr to match on the `[claude-code...]` marker).
 *    Emitting it as an `error` event shows a red banner AND flips the
 *    assistant message to streaming:false in the UI, which discards the real
 *    reply that follows — the customer-visible symptom behind this filter.
 *    Persist it as `raw` instead: still lands in events.jsonl for diagnosis,
 *    ignored by the frontend.
 *
 * 3. Gemini CLI (observed on 0.57.0) prints headless startup banners to
 *    stderr on EVERY run: the YOLO approval notice ("YOLO mode is enabled…",
 *    emitted twice because Molio passes both --yolo and --skip-trust), the
 *    ripgrep fallback note, and one "Skill … is overriding the built-in
 *    skill." line per shadowed builtin skill. The run itself succeeds — the
 *    reply arrives via stdout stream-json — but surfacing these banners as
 *    `error` events shows a red banner and makes the run look failed.
 *    Same treatment as the Claude marker: demote known banner lines to
 *    `raw`, keep anything else as an `error` event.
 */
export function classifyStderrChunk(agentId: string, text: string): AgentEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Codex CLI informational stderr — drop entirely (existing behavior).
  if (agentId === 'codex' && (
    trimmed.includes('Reading prompt from stdin') ||
    trimmed.includes('Reading additional input from stdin')
  )) {
    return [];
  }

  // Gemini CLI headless startup banners — demote known informational lines
  // to `raw`, keep any genuine error lines in the same chunk as an `error`
  // event.
  if (agentId === 'gemini') {
    const events: AgentEvent[] = [];
    const errorLines: string[] = [];
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (isGeminiInfoLine(line)) {
        events.push({ type: 'raw', line });
      } else {
        errorLines.push(line);
      }
    }
    if (errorLines.length > 0) {
      events.push({ type: 'error', message: errorLines.join('\n') });
    }
    return events;
  }

  // Claude Code print-mode diagnostics — demote marker lines to `raw`, keep
  // any genuine error lines in the same chunk as an `error` event.
  if (agentId === 'claude' && trimmed.includes('[claude-code:')) {
    const events: AgentEvent[] = [];
    const errorLines: string[] = [];
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('[claude-code:')) {
        events.push({ type: 'raw', line });
      } else {
        errorLines.push(line);
      }
    }
    if (errorLines.length > 0) {
      events.push({ type: 'error', message: errorLines.join('\n') });
    }
    return events;
  }

  return [{ type: 'error', message: trimmed }];
}

/**
 * Gemini CLI stderr lines that are pure startup diagnostics (observed on
 * 0.57.0 headless runs). Deliberately NOT matched:
 * "Approval mode overridden to \"default\" because the current folder is not
 * trusted." — that one signals yolo being silently disabled, which genuinely
 * breaks a headless run (tool calls can't be auto-approved), so it must keep
 * surfacing as an error.
 */
function isGeminiInfoLine(line: string): boolean {
  return (
    line.startsWith('YOLO mode is enabled') ||
    line.startsWith('Ripgrep is not available') ||
    /is overriding the built-in skill\.?$/.test(line)
  );
}
