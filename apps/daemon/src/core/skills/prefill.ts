/**
 * "Save as skill" prefill — run a one-shot Claude invocation that summarizes an
 * assistant message into a skill definition { name, description, instructions }.
 *
 * Always resolves (never throws): on any failure (Claude not installed, timeout,
 * unparsable output) it returns a raw-content fallback so the user still gets an
 * editable form. The throwaway run is cancelled on settle to avoid orphan procs.
 */
import fs from 'node:fs';
import os from 'node:os';
import type { PrefillResult } from '@molio/contracts';
import type { RunManager } from '../RunManager.js';
import { scratchDir, type SkillPathsOpts } from './paths.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function buildPrefillPrompt(content: string): string {
  return [
    '你是一个技能策展人。阅读下面的助手回复，把它沉淀成一个可复用的「技能」定义。',
    '只输出一个 JSON 对象，不要任何其它文字、不要 markdown 代码块、不要解释：',
    '{"name": "<简短技能名，2-6 个字>", "description": "<一句话说明这个技能什么时候用>", "instructions": "<技能的指令正文，写成给 AI 的明确步骤>"}',
    '',
    '助手回复：',
    '---',
    content,
    '---',
  ].join('\n');
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  const m = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/);
  return m && m[1] ? m[1].trim() : text;
}

function firstToLastBrace(text: string): string {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  return first >= 0 && last > first ? text.slice(first, last + 1) : text;
}

/**
 * Parse an AI prefill response into a PrefillResult. Pure + side-effect free.
 * Tries: direct JSON → code-fenced JSON → first-{..last-} substring → fallback.
 */
export function parsePrefillResponse(rawText: string, fallbackContent: string): PrefillResult {
  const fallback: PrefillResult = {
    name: '未命名技能',
    description: '',
    instructions: fallbackContent,
    fallback: true,
  };
  const text = (rawText ?? '').trim();
  if (!text) return fallback;

  const parsed =
    tryParseJson(text) ??
    tryParseJson(stripCodeFence(text)) ??
    tryParseJson(firstToLastBrace(text));
  if (!parsed) return fallback;

  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallback.name;
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const instructions =
    typeof parsed.instructions === 'string' && parsed.instructions.trim()
      ? parsed.instructions
      : fallbackContent;

  return { name, description, instructions };
}

function ensureScratchCwd(opts?: SkillPathsOpts): string {
  const dir = scratchDir(opts);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    // Non-fatal: this runs inside the prefill promise executor, so throwing
    // here would reject the promise and break the "always resolves" contract
    // (the route has no try/catch → 500 instead of the editable fallback form).
    // Fall back to the OS temp dir when ~/.molio is unwritable.
    return os.tmpdir();
  }
}

export async function prefillFromContent(
  content: string,
  runManager: RunManager,
  opts?: SkillPathsOpts & { timeoutMs?: number },
): Promise<PrefillResult> {
  const fallback: PrefillResult = {
    name: '未命名技能',
    description: '',
    instructions: content,
    fallback: true,
  };
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let runId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return new Promise<PrefillResult>((resolve) => {
    let settled = false;
    const settle = (result: PrefillResult) => {
      if (settled) return;
      settled = true;
      if (unsubscribe) {
        try { unsubscribe(); } catch { /* ignore */ }
      }
      if (timer) clearTimeout(timer);
      if (runId) {
        try { runManager.cancelRun(runId); } catch { /* ignore */ }
      }
      resolve(result);
    };

    runManager
      .createRun({
        agentId: 'claude',
        message: buildPrefillPrompt(content),
        cwd: ensureScratchCwd(opts),
        onTurnComplete: (text) => settle(parsePrefillResponse(text, content)),
      })
      .then((rid) => {
        // Race guard: if the timeout (or a spawn-side failure) already settled
        // this prefill while createRun was still pending, the run is an orphan —
        // cancel it right away instead of leaking the agent process.
        if (settled) {
          try { runManager.cancelRun(rid); } catch { /* ignore */ }
          return;
        }
        runId = rid;
        unsubscribe =
          runManager.onEvent(rid, (event) => {
            if (event.type !== 'status') return;
            const label = (event as { label?: string }).label;
            // 'completed' with no delivered text (empty turn) → fallback.
            // 'failed' / 'canceled' → fallback. Non-empty text already settled
            // via onTurnComplete before 'completed' fires, so this is ignored then.
            if (label === 'completed' || label === 'failed' || label === 'canceled') {
              settle(fallback);
            }
          }) ?? null;
      })
      .catch(() => settle(fallback)); // binary not found / spawn failure

    timer = setTimeout(() => settle(fallback), timeoutMs);
  });
}
