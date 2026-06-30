import { useState } from 'react';
import { useI18n } from '../i18n';
import type { ToolEvent } from '../hooks/useChat';

interface Props {
  tool: ToolEvent;
  /** True only for tool calls inside the most recent assistant message. */
  isLast?: boolean;
  /** Submit handler: routes tool_result back to the open stream-json child. */
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
  /** Fallback: sends the answer as a fresh user message. */
  onSubmitForm?: (text: string) => void;
}

export function ToolCard({ tool, isLast, onAnswerToolUse, onSubmitForm }: Props) {
  // Dispatch to AskUserQuestionCard for interactive question handling
  if (tool.name === 'AskUserQuestion' || tool.name === 'ask_user_question') {
    return (
      <AskUserQuestionCard
        toolUseId={tool.id}
        input={tool.input}
        result={tool.result}
        isError={tool.isError}
        status={tool.status}
        isLast={isLast ?? false}
        onSubmitForm={onSubmitForm}
        onAnswerToolUse={onAnswerToolUse}
      />
    );
  }

  // Default: Claude Code style — minimal inline one-liner
  const detail = formatToolInput(tool.input);
  const statusClass = tool.status === 'running' ? 'running' : tool.isError ? 'error' : 'done';
  const statusLabel = tool.status === 'running' ? '…' : tool.isError ? '✗' : '✓';

  return (
    <div className="tool-line">
      <span className="tool-line-arrow">⎿</span>
      <span className="tool-line-name">{tool.name}</span>
      {detail && <span className="tool-line-arg">{detail}</span>}
      <span className={`tool-line-status ${statusClass}`}>{statusLabel}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AskUserQuestion interactive card
// ---------------------------------------------------------------------------

type AuqOption = { label: string; description?: string };
type AuqQuestion = {
  question: string;
  header?: string;
  options: AuqOption[];
  multiSelect: boolean;
};

function parseAskUserQuestionInput(input: unknown): AuqQuestion[] {
  const obj = (input ?? {}) as { questions?: unknown };
  if (!Array.isArray(obj.questions)) return [];
  const result: AuqQuestion[] = [];
  for (const raw of obj.questions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = raw as Record<string, unknown>;
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    const header = typeof q.header === 'string' ? q.header : undefined;
    const multiSelect = q.multiSelect === true;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: AuqOption[] = [];
    for (const opt of rawOptions) {
      if (typeof opt === 'string') {
        options.push({ label: opt });
      } else if (opt && typeof opt === 'object') {
        const o = opt as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label : '';
        if (!label) continue;
        const description = typeof o.description === 'string' ? o.description : undefined;
        options.push(description ? { label, description } : { label });
      }
    }
    if (options.length === 0) continue;
    result.push({ question, header, options, multiSelect });
  }
  return result;
}

function AskUserQuestionCard({
  toolUseId,
  input,
  result,
  isError,
  status,
  isLast,
  onSubmitForm,
  onAnswerToolUse,
}: {
  toolUseId: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: ToolEvent['status'];
  isLast: boolean;
  onSubmitForm?: (text: string) => void;
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useI18n();
  const questions = parseAskUserQuestionInput(input);
  const [selections, setSelections] = useState<Record<string, string | string[]>>(() => {
    const seed: Record<string, string | string[]> = {};
    for (const q of questions) seed[q.question] = q.multiSelect ? [] : '';
    return seed;
  });
  const [submitted, setSubmitted] = useState(false);

  if (questions.length === 0) {
    // Fallback: render as generic card if we can't parse the input
    const detail = formatToolInput(input);
    return (
      <div className="tool-card">
        <div className="tool-card-header">
          <span className="tool-card-icon">?</span>
          <span className="tool-card-name">AskUserQuestion</span>
          {detail && <span className="tool-card-detail">{detail}</span>}
          <span className={`tool-card-status ${status === 'running' ? 'running' : isError ? 'error' : 'done'}`}>
            {status === 'running' ? '...' : isError ? '✗' : '✓'}
          </span>
        </div>
        {result && <div className={`tool-card-body ${isError ? 'error' : ''}`}>{result}</div>}
      </div>
    );
  }

  // Real answer = non-error result OR local submitted flag
  const hasRealAnswer = (!!result && !isError) || submitted;

  // Parse persisted answer from result content (for page reloads)
  const answeredSelections = (() => {
    if (!result || isError) return null;
    const out: Record<string, string | string[]> = {};
    const pairs = result.split('\n\n');
    for (const pair of pairs) {
      const newlineIdx = pair.indexOf('\n');
      if (newlineIdx === -1) continue;
      const q = pair.slice(0, newlineIdx).trim();
      const a = pair.slice(newlineIdx + 1).trim();
      if (!q) continue;
      const question = questions.find((qq) => qq.question === q);
      if (!question) continue;
      out[q] = question.multiSelect
        ? a.split('\n').map((s) => s.replace(/^- /, '').trim()).filter(Boolean)
        : a;
    }
    return out;
  })();

  const effectiveSelections = hasRealAnswer && answeredSelections
    ? answeredSelections
    : selections;

  const canSubmit = !!onAnswerToolUse || !!onSubmitForm;
  const locked = hasRealAnswer || !isLast || !canSubmit;
  const ready = questions.every((q) => {
    const v = selections[q.question];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
  });

  function pickSingle(question: string, label: string) {
    if (locked) return;
    setSelections((prev) => ({ ...prev, [question]: label }));
  }

  function toggleMulti(question: string, label: string) {
    if (locked) return;
    setSelections((prev) => {
      const current = Array.isArray(prev[question]) ? (prev[question] as string[]) : [];
      const next = current.includes(label)
        ? current.filter((v) => v !== label)
        : [...current, label];
      return { ...prev, [question]: next };
    });
  }

  async function handleSubmit() {
    if (locked || !ready) return;
    const lines = questions.map((q) => {
      const v = selections[q.question];
      const answer = Array.isArray(v) ? v.map((s) => `- ${s}`).join('\n') : (v ?? '');
      return `${q.question}\n${answer}`;
    });
    const formatted = lines.join('\n\n');

    if (onAnswerToolUse) {
      setSubmitted(true);
      try {
        const ok = await onAnswerToolUse(toolUseId, formatted);
        if (ok === false) {
          setSubmitted(false);
          onSubmitForm?.(formatted);
        }
      } catch {
        setSubmitted(false);
        onSubmitForm?.(formatted);
      }
      return;
    }
    if (onSubmitForm) {
      setSubmitted(true);
      onSubmitForm(formatted);
    }
  }

  const statusLabel = hasRealAnswer ? t('tool.answered') : !locked ? t('tool.awaiting') : null;
  const statusClass = hasRealAnswer ? 'done' : 'awaiting';

  return (
    <div className={`tool-card ask-user-question${locked ? ' locked' : ''}`}>
      <div className="tool-card-header">
        <span className="tool-card-icon">?</span>
        <span className="tool-card-name">AskUserQuestion</span>
        {statusLabel && (
          <span className={`tool-card-status ${statusClass}`}>{statusLabel}</span>
        )}
      </div>
      <div className="ask-question-body">
        {questions.map((q) => {
          const selected = effectiveSelections[q.question];
          return (
            <div key={q.question} className="ask-question-field">
              {q.header && (
                <div className="ask-question-header">{q.header}</div>
              )}
              <div className="ask-question-prompt">{q.question}</div>
              <div className="ask-question-options">
                {q.options.map((opt) => {
                  const isOn = Array.isArray(selected)
                    ? selected.includes(opt.label)
                    : selected === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`ask-question-option${isOn ? ' on' : ''}`}
                      aria-pressed={isOn}
                      disabled={locked}
                      onClick={() => (q.multiSelect ? toggleMulti(q.question, opt.label) : pickSingle(q.question, opt.label))}
                    >
                      <span className="ask-question-option-label">{opt.label}</span>
                      {opt.description && (
                        <span className="ask-question-option-desc">{opt.description}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {!locked && (
        <div className="ask-question-foot">
          <button
            type="button"
            className="ask-question-submit"
            disabled={!ready}
            onClick={handleSubmit}
          >
            {t('tool.submit')}
          </button>
        </div>
      )}
    </div>
  );
}


function formatToolInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, 80);
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj['command'] === 'string') return truncate(obj['command'] as string, 80);
    if (typeof obj['file_path'] === 'string') return obj['file_path'] as string;
    if (typeof obj['description'] === 'string') return truncate(obj['description'] as string, 80);
    if (typeof obj['url'] === 'string') return obj['url'] as string;
    return truncate(JSON.stringify(input), 80);
  }
  return '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
