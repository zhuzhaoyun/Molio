import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import type { ToolEvent } from '../hooks/useChat';
import { CopyIcon } from './icons';

interface Props {
  tool: ToolEvent;
  /** True only for tool calls inside the most recent assistant message. */
  isLast?: boolean;
  /** Submit handler: routes tool_result back to the open stream-json child. */
  onAnswerToolUse?: (toolUseId: string, content: string) => Promise<boolean | void> | boolean | void;
  /** Fallback: sends the answer as a fresh user message. */
  onSubmitForm?: (text: string) => void;
  /** Full tools array from the assistant message, used for hasRetrySucceeded check. */
  allTools?: ToolEvent[];
  /** 流式操作日志：最新工具处于打开态，结果到达即展开（不被默认折叠覆盖）。 */
  open?: boolean;
  /** 步序号（流式操作区逐个展示时）。 */
  step?: number;
  totalSteps?: number;
}

export function ToolCard({ tool, isLast, onAnswerToolUse, onSubmitForm, allTools, open, step, totalSteps }: Props) {
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

  return (
    <DefaultToolCard
      tool={tool}
      allTools={allTools ?? []}
      open={open}
      step={step}
      totalSteps={totalSteps}
    />
  );
}

// ── DefaultToolCard — all hooks live here at top level (Rules of Hooks) ──

function hasRetrySucceeded(tools: ToolEvent[], toolIndex: number): boolean {
  const current = tools[toolIndex];
  if (!current || !current.isError) return false;
  for (let i = toolIndex + 1; i < tools.length; i++) {
    const later = tools[i];
    if (later?.name === current.name && later.status === 'done' && !later.isError) {
      return true;
    }
  }
  return false;
}

function DefaultToolCard({
  tool,
  allTools,
  open,
  step,
  totalSteps,
}: {
  tool: ToolEvent;
  allTools: ToolEvent[];
  open?: boolean;
  step?: number;
  totalSteps?: number;
}) {
  const toolIndex = allTools.findIndex(t => t.id === tool.id);
  const retrySucceeded = hasRetrySucceeded(allTools, toolIndex);
  const hasOutput = tool.status !== 'running' && tool.result !== undefined && tool.result !== '';
  // ── Elapsed time + expand state ──
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const startRef = useRef<number>(0);
  const manualRef = useRef(false); // user manually toggled — disable auto open/close
  const autoExpandedRef = useRef(false); // auto-expand triggered — keep open on done

  // Elapsed-time timer: 优先用事件携带的 startedAt/finishedAt（工作块折叠再展开、
  // 工具行重新挂载时依然能还原真实耗时）；运行中则实时累加。
  useEffect(() => {
    if (tool.status === 'running') {
      startRef.current = Date.now();
      setElapsed(0);
      const timer = setInterval(() => {
        const start = tool.startedAt ?? startRef.current;
        setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
      }, 200);
      return () => clearInterval(timer);
    }
    // done/error：沉淀为存储时间戳之差（挂载时若仍在流式中途则退化为本挂载计时）
    if (tool.startedAt != null && tool.finishedAt != null) {
      setElapsed(Math.max(0, Math.round((tool.finishedAt - tool.startedAt) / 1000)));
    } else if (startRef.current) {
      setElapsed(Math.max(0, Math.round((Date.now() - startRef.current) / 1000)));
    }
  }, [tool.status, tool.startedAt, tool.finishedAt]);

  // Reset auto-expand flag when a new tool mounts
  useEffect(() => {
    autoExpandedRef.current = false;
  }, [tool.id]);

  // Smart auto-expand
  useEffect(() => {
    if (manualRef.current) return;

    // 被更新的工具取代（流式工作日志中 open 显式翻 false）→ 不再是最新焦点：
    // 结果到达后一律收起，不受 autoExpandedRef 影响（慢工具 ≥5s 自动展开过也不留）。
    // 完成态详情 / 交互卡不传 open（undefined），不会落入此分支。
    if (open === false && hasOutput && !tool.isError) {
      setExpanded(false);
      autoExpandedRef.current = false;
      return;
    }

    // open（流式最新工具）：结果到达即展开 —— 不被默认折叠覆盖；
    // 无结果（运行中）则落到 ≥5s 规则，保持慢工具提前展开的行为
    if (open && hasOutput) {
      setExpanded(true);
      return;
    }

    // ≥5s running → expand（仅最新/未被取代工具触发；被取代后焦点已转移，不再自动展开）
    if (open !== false && tool.status === 'running' && elapsed >= 5) {
      setExpanded(true);
      autoExpandedRef.current = true;
      return;
    }

    // Final failure (no later retry succeeded) → expand to show error
    if (tool.status === 'error' && !retrySucceeded) {
      setExpanded(true);
      return;
    }

    // Intermediate failure (later retry succeeded) → collapse
    if (tool.status === 'error' && retrySucceeded) {
      setExpanded(false);
      autoExpandedRef.current = false;
      return;
    }

    // Successfully done, not auto-expanded → collapse
    if (tool.status === 'done' && !tool.isError && !autoExpandedRef.current) {
      setExpanded(false);
    }
  }, [open, hasOutput, tool.status, elapsed, tool.isError, retrySucceeded]);

  const toggleExpand = () => {
    manualRef.current = true;
    setExpanded((prev) => !prev);
  };

  const chevron = hasOutput ? (expanded ? '▾' : '▸') : '';

  // ── Tool-line rendering ──
  const agentMeta = agentToolMeta(tool.name, tool.input);
  const detail = agentMeta ? agentMeta.label : formatToolInput(tool.input);
  const statusClass = tool.status === 'running' ? 'running' : tool.isError ? 'error' : 'done';
  const statusLabel = tool.status === 'running'
    ? ''
    : tool.isError ? '✗' : '✓';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!hasOutput) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  };

  return (
    <div className="tool-card-wrapper" data-tool-id={tool.id}>
      <div
        className={`tool-line${hasOutput ? ' has-output' : ''}${tool.status === 'running' ? ' running' : ''}`}
        role={hasOutput ? 'button' : undefined}
        tabIndex={hasOutput ? 0 : undefined}
        aria-expanded={hasOutput ? expanded : undefined}
        onClick={hasOutput ? toggleExpand : undefined}
        onKeyDown={handleKeyDown}
        data-testid="tool-line"
      >
        {step != null && totalSteps != null && (
          <span className="tool-line-step">{step}/{totalSteps}</span>
        )}
        <span className="tool-line-arrow">{'⎿'}</span>
        <span className="tool-line-name">{tool.name}</span>
        {agentMeta?.badge && <span className="tool-line-badge">{agentMeta.badge}</span>}
        {detail && <span className="tool-line-arg">{detail}</span>}
        <span className={`tool-line-status ${statusClass}`}>{statusLabel}</span>
        <span className="tool-line-elapsed">
          {tool.status === 'running' && `⏱ ${elapsed}s`}
          {tool.status !== 'running' && elapsed > 0 && `⏱ ${elapsed}s`}
        </span>
        {chevron && <span className="tool-line-chevron">{chevron}</span>}
      </div>

      {/* ── Expandable output panel ── */}
      {expanded && hasOutput && (
        <div className="tool-output-panel" data-testid="tool-output-panel">
          {!!tool.input && typeof tool.input === 'object' && 'command' in (tool.input as Record<string, unknown>) && (
            <div className="tool-output-cmd">
              $ {(tool.input as Record<string, unknown>).command as string}
            </div>
          )}
          <pre className="tool-output-body">{tool.result}</pre>
          {(tool.result && tool.result.length > 0) && (
            <div className="tool-output-foot">
              <button
                type="button"
                className="icon-btn"
                data-testid="tool-output-copy-btn"
                aria-label="复制输出内容"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await navigator.clipboard.writeText(tool.result ?? '');
                  } catch { /* noop */ }
                }}
              >
                <CopyIcon />
              </button>
            </div>
          )}
        </div>
      )}
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
    if (typeof obj['query'] === 'string') return truncate(obj['query'] as string, 80);
    return truncate(JSON.stringify(input), 80);
  }
  return '';
}

// ── Agent-family tools (Task/Agent/Workflow/SendMessage) ──
// Richer display than the generic fallback: a human label extracted from the
// tool input (subagent description, workflow meta, message summary) plus an
// optional badge (subagent_type). The raw Workflow script can be multi-KB —
// formatToolInput would dump its head as JSON noise; this extracts the meta
// block (name/description) the workflow author wrote for humans.

const AGENT_TOOL_NAMES = new Set(['Task', 'Agent', 'SendMessage', 'Workflow']);

interface AgentToolMeta {
  label: string;
  badge?: string;
}

function agentToolMeta(name: string, input: unknown): AgentToolMeta | null {
  if (!AGENT_TOOL_NAMES.has(name)) return null;
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  if (name === 'Workflow') {
    let wfName = '';
    let label = '';
    if (typeof obj['script'] === 'string') {
      wfName = obj['script'].match(/name:\s*['"]([^'"]+)['"]/)?.[1] ?? '';
      label = obj['script'].match(/description:\s*['"]([^'"]+)['"]/)?.[1] ?? wfName;
    } else if (typeof obj['scriptPath'] === 'string') {
      wfName = (obj['scriptPath'] as string).split(/[\\/]/).pop() ?? '';
      label = wfName;
    } else if (typeof obj['name'] === 'string') {
      wfName = obj['name'] as string;
      label = wfName;
    }
    return { label: truncate(label || 'workflow', 80), badge: wfName || undefined };
  }

  if (name === 'SendMessage') {
    const to = typeof obj['to'] === 'string' ? (obj['to'] as string) : '';
    const summary = typeof obj['summary'] === 'string'
      ? (obj['summary'] as string)
      : typeof obj['message'] === 'string' ? truncate(obj['message'] as string, 60) : '';
    return { label: `${to ? '→ ' + to + '：' : ''}${summary}` };
  }

  // Task / Agent — subagent spawn
  const desc = typeof obj['description'] === 'string'
    ? (obj['description'] as string)
    : typeof obj['prompt'] === 'string' ? truncate(obj['prompt'] as string, 80) : '';
  const badge = typeof obj['subagent_type'] === 'string' ? (obj['subagent_type'] as string) : undefined;
  return { label: desc, badge };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
