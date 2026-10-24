import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { useActiveVaultId } from '../stores/vaultStore';
import { useWikiLinkClick } from '../hooks/useWikiLinkClick';
import { CodeBlock } from './CodeBlock';
import { renderMarkdown } from '../utils/markdown';
import { saveQuizToVault } from '../utils/quizFile';
import {
  parseQuizBlock,
  gradeQuiz,
  isQuizComplete,
  computeQuizFingerprint,
  quizStorageKey,
  parseStoredQuizState,
  quizStemOf,
  MAX_QUIZ_KEY_CHARS,
  type InvalidQuestion,
  type Quiz,
  type QuizGrade,
  type QuizSelections,
} from '../utils/quiz';

interface Props {
  /** JSON text inside the ```quiz fence. */
  raw: string;
  /** False while the closing fence has not arrived yet. */
  complete: boolean;
  /** True when the containing assistant message is still streaming. */
  streaming?: boolean;
  /** Used for localStorage scoping. */
  conversationId?: string | null;
}

/** 填空符号托盘：通用难输入字符（理工科一期组）。分组与后置项依据
 *  docs/2026-10-24-quiz-fill-input-domains.md（文科/小语种组后续按需追加）。 */
const FILL_SYMBOL_GROUPS: ReadonlyArray<{ labelKey: string; chars: readonly string[] }> = [
  { labelKey: 'quiz.symbolGroup.common', chars: ['√', 'π', '°', '≤', '≥', '≠', '±', '→', '×', '÷', '∞'] },
  { labelKey: 'quiz.symbolGroup.greek', chars: ['α', 'β', 'γ', 'δ', 'θ', 'λ', 'μ', 'σ', 'ω', 'Δ', 'Ω'] },
  { labelKey: 'quiz.symbolGroup.logic', chars: ['∪', '∩', '∈', '⊂', '∅', '∀', '∃', '⇒', '⇔'] },
  { labelKey: 'quiz.symbolGroup.units', chars: ['‰', '′', '″', '↑', '↓', '⇌'] },
];

/**
 * Quiz 交互块（交互块注册表的第一个块）。
 *
 * 只解析 JSON，不执行任何代码；题干/选项/解析经 renderMarkdown 渲染
 * （先转义 HTML 再生成受控标签，与聊天正文同一信任级）。
 * 判分在本地完成（不依赖 runtime 工具调用），提交后可重做、可存题库。
 */
export function QuizCard({ raw, complete, streaming, conversationId }: Props) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseQuizBlock(raw), [raw]);

  if (!complete) {
    return (
      <div className="quiz-generating" data-testid="quiz-generating">
        {streaming ? t('quiz.generating') : t('quiz.incomplete')}
      </div>
    );
  }

  if (!parsed.ok) {
    return (
      <div className="quiz-invalid" data-testid="quiz-invalid">
        <div className="quiz-invalid-hint">{t('quiz.invalid')}</div>
        <CodeBlock lang="quiz" code={raw} streaming={false} />
      </div>
    );
  }

  return (
    <QuizBody
      quiz={parsed.quiz}
      invalidQuestions={parsed.invalidQuestions}
      conversationId={conversationId}
    />
  );
}

function QuizBody({
  quiz,
  invalidQuestions,
  conversationId,
}: {
  quiz: Quiz;
  invalidQuestions: InvalidQuestion[];
  conversationId?: string | null;
}) {
  const { t } = useI18n();
  const vaultId = useActiveVaultId();
  const handleWikiLinkClick = useWikiLinkClick();

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [selections, setSelections] = useState<QuizSelections>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const restoredKeyRef = useRef<string | null>(null);

  const grades = useMemo(
    () => (submitted ? gradeQuiz(quiz, selections) : []),
    [submitted, quiz, selections],
  );
  const gradeMap = useMemo(
    () => new Map<string, QuizGrade>(grades.map((grade) => [grade.questionId, grade])),
    [grades],
  );
  const answeredCount = quiz.questions.filter(
    (question) => (selections[question.id]?.length ?? 0) > 0,
  ).length;
  const ready = isQuizComplete(quiz, selections);
  const storageKey =
    fingerprint && conversationId ? quizStorageKey(conversationId, fingerprint) : null;

  useEffect(() => {
    let cancelled = false;
    setFingerprint(null);
    computeQuizFingerprint(quiz)
      .then((value) => {
        if (!cancelled) setFingerprint(value);
      })
      .catch(() => {
        // 指纹失败时不写 localStorage，避免脏键。
      });
    return () => {
      cancelled = true;
    };
  }, [quiz]);

  // 恢复与写入共用同一个 key 守卫：key 变化时，恢复完成前不允许写，
  // 否则会把上一条 quiz 的选择写进新键。
  useEffect(() => {
    if (!storageKey) return;
    restoredKeyRef.current = null;
    setSelections({});
    setSubmitted(false);
    try {
      const stored = parseStoredQuizState(localStorage.getItem(storageKey));
      if (stored) {
        setSelections(stored.selections);
        setSubmitted(stored.submitted);
      }
    } catch {
      // localStorage 不可用（隐私模式等）→ 只在内存里作答。
    }
    restoredKeyRef.current = storageKey;
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || restoredKeyRef.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ selections, submitted }));
    } catch {
      // 配额/隐私模式：不阻塞答题。
    }
  }, [storageKey, selections, submitted]);

  const toggle = useCallback(
    (questionId: string, type: Quiz['questions'][number]['type'], key: string) => {
      if (submitted) return;
      setSelections((prev) => {
        const current = prev[questionId] ?? [];
        if (type === 'multiple') {
          return {
            ...prev,
            [questionId]: current.includes(key)
              ? current.filter((item) => item !== key)
              : [...current, key],
          };
        }
        return { ...prev, [questionId]: [key] };
      });
    },
    [submitted],
  );

  // 填空作答：空文本存空数组（isQuizComplete 据此判未作答）。
  const setFillText = useCallback(
    (questionId: string, text: string) => {
      if (submitted) return;
      setSelections((prev) => ({ ...prev, [questionId]: text.trim() ? [text] : [] }));
    },
    [submitted],
  );

  const fillInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // 唤起式符号托盘：一次只开一道题的（点触发钮切换，点外部/Esc 关闭）。
  const [openSymbolsFor, setOpenSymbolsFor] = useState<string | null>(null);

  useEffect(() => {
    if (!openSymbolsFor) return;
    const closeOnOutside = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(`[data-fill-scope="${openSymbolsFor}"]`)) return;
      setOpenSymbolsFor(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenSymbolsFor(null);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openSymbolsFor]);

  // 符号面板：在光标处插入字符。onMouseDown preventDefault 保住输入框焦点；
  // 键盘用户走折叠判分（pi/sqrt/<=…），面板是鼠标/触屏的兜底输入。
  const insertSymbol = useCallback(
    (questionId: string, char: string) => {
      if (submitted) return;
      const input = fillInputRefs.current[questionId];
      if (!input) return;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const next = input.value.slice(0, start) + char + input.value.slice(end);
      setFillText(questionId, next);
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start + char.length, start + char.length);
      });
    },
    [submitted, setFillText],
  );

  const handleSubmit = useCallback(() => {
    if (!ready || submitted) return;
    setSubmitted(true);

    // 本地判分已完成；落库失败不阻塞用户看结果。
    // 空/超长 chosen 不进批次：daemon 对两者整批拒绝，会把整次提交的答题
    // 记录全部丢掉。超长只可能来自被改过的 localStorage（正常输入被
    // maxLength 挡住），丢弃该题保住其余题目的落库。
    if (fingerprint) {
      const attempts = gradeQuiz(quiz, selections)
        .filter((grade) =>
          grade.chosen.length > 0
          && grade.chosen.every((key) => key.length <= MAX_QUIZ_KEY_CHARS),
        )
        .map((grade) => ({
        questionId: grade.questionId,
        chosen: grade.chosen,
        correct: grade.correct,
      }));
      void api.saveQuizAttempts({
        vaultId: vaultId ?? null,
        quizFingerprint: fingerprint,
        conversationId: conversationId ?? null,
        attempts,
      }).catch(() => {
        // 一期不向用户暴露落库失败：答题体验优先，错题本/统计是二期能力。
      });
    }
  }, [ready, submitted, fingerprint, quiz, selections, vaultId, conversationId]);

  const handleRedo = useCallback(() => {
    setSelections({});
    setSubmitted(false);
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  }, [storageKey]);

  const handleSave = useCallback(async () => {
    if (!vaultId || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const path = await saveQuizToVault(vaultId, quiz, api);
      setSavedPath(path);
    } catch {
      setSaveError(t('quiz.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [vaultId, saving, quiz, t]);

  return (
    <div className="quiz-card" data-testid="quiz-card">
      <div className="quiz-card-title" data-testid="quiz-title">{quiz.title}</div>

      {quiz.questions.map((question, index) => {
        const chosen = selections[question.id] ?? [];
        const grade = gradeMap.get(question.id);
        return (
          <div className="quiz-question" data-testid="quiz-question" data-question-id={question.id} key={question.id}>
            <div className="quiz-question-head">
              <span className="quiz-index">{t('quiz.question', { n: index + 1 })}</span>
              <span className="quiz-type" data-testid="quiz-type">{t(`quiz.type.${question.type}`)}</span>
              {grade && (
                <span
                  className={`quiz-result ${grade.correct ? 'correct' : 'wrong'}`}
                  data-testid="quiz-result"
                  data-correct={grade.correct ? 'true' : 'false'}
                >
                  {grade.correct ? t('quiz.correct') : t('quiz.wrong')}
                </span>
              )}
            </div>

            {/* 题干走受控 markdown（renderMarkdown 先转义 HTML）：图片/加粗/
                上下标等才能显示；`____` 空位标记不受强调语法影响。 */}
            <div
              className="quiz-stem"
              data-testid="quiz-stem"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(question.stem) }}
            />

            <div className="quiz-options">
              {question.type === 'fill' ? (
                /* 填空：文本作答。判分在 gradeQuiz 里做规范化匹配（含 ASCII 记法折叠）；
                 * 64 上限与 daemon chosen 逐项上限一致，超长会落不了库。 */
                <div className="quiz-fill" data-fill-scope={question.id}>
                  <div className="quiz-input-row">
                    <input
                      ref={(el) => { fillInputRefs.current[question.id] = el; }}
                      className="quiz-fill-input"
                      data-testid="quiz-fill-input"
                      data-question-id={question.id}
                      type="text"
                      value={chosen[0] ?? ''}
                      maxLength={MAX_QUIZ_KEY_CHARS}
                      aria-label={t('quiz.fillPlaceholder')}
                      placeholder={t('quiz.fillPlaceholder')}
                      disabled={submitted}
                      onChange={(event) => setFillText(question.id, event.target.value)}
                    />
                    <button
                      type="button"
                      className={`quiz-symbol-trigger${openSymbolsFor === question.id ? ' on' : ''}`}
                      data-testid="quiz-symbol-trigger"
                      aria-expanded={openSymbolsFor === question.id}
                      disabled={submitted}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setOpenSymbolsFor((prev) => (prev === question.id ? null : question.id))}
                    >
                      {t('quiz.symbolTrigger')}
                    </button>
                  </div>
                  {openSymbolsFor === question.id && (
                    <div className="quiz-symbol-tray" data-testid="quiz-symbol-tray">
                      {FILL_SYMBOL_GROUPS.map((group) => (
                        <div className="quiz-symbol-group" key={group.labelKey}>
                          <span className="quiz-symbol-group-label">{t(group.labelKey)}</span>
                          <div className="quiz-symbol-keys">
                            {group.chars.map((char) => (
                              <button
                                key={char}
                                type="button"
                                className="quiz-symbol-btn"
                                data-testid="quiz-symbol-btn"
                                data-char={char}
                                aria-label={char}
                                disabled={submitted}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => insertSymbol(question.id, char)}
                              >
                                {char}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : question.options.map((option) => {
                const on = chosen.includes(option.key);
                const isAnswer = question.answer.includes(option.key);
                const className = [
                  'quiz-option',
                  on ? 'on' : '',
                  submitted && isAnswer ? 'correct' : '',
                  submitted && on && !isAnswer ? 'wrong' : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={option.key}
                    type="button"
                    className={className}
                    data-testid="quiz-option"
                    data-question-id={question.id}
                    data-key={option.key}
                    aria-pressed={on}
                    disabled={submitted}
                    onClick={() => toggle(question.id, question.type, option.key)}
                  >
                    <span className="quiz-option-key">{option.key}</span>
                    <span
                      className="quiz-option-text"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(option.text) }}
                    />
                  </button>
                );
              })}
            </div>

            {grade && (
              <div className="quiz-answer" data-testid="quiz-answer">
                {t('quiz.answer', { answer: question.answer.join(' / ') })}
              </div>
            )}

            {grade && (
              <div className="quiz-explanation" data-testid="quiz-explanation">
                <div className="quiz-section-label">{t('quiz.explanation')}</div>
                {/* renderMarkdown 先转义 HTML，再生成受控标签。 */}
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(question.explanation) }} />
              </div>
            )}

            {grade && question.sources.length > 0 && (
              <div className="quiz-sources" data-testid="quiz-sources" onClick={handleWikiLinkClick}>
                <div className="quiz-section-label">{t('quiz.sources')}</div>
                {question.sources.map((source, sourceIndex) => (
                  <div className="quiz-source-row" key={`${source.path}-${sourceIndex}`}>
                    <button
                      type="button"
                      className="kb-wiki-link quiz-source"
                      data-testid="quiz-source"
                      data-file-path={source.path}
                    >
                      {source.path}
                    </button>
                    {source.quote && <span className="quiz-source-quote">{source.quote}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {invalidQuestions.length > 0 && (
        <div className="quiz-invalid-questions">
          {invalidQuestions.map((invalid) => (
            <div
              className="quiz-question quiz-question-invalid"
              data-testid="quiz-question-invalid"
              key={invalid.index}
            >
              <div className="quiz-stem">{quizStemOf(invalid.raw) ?? t('quiz.questionInvalid')}</div>
              <div className="quiz-error">{invalid.reason}</div>
            </div>
          ))}
        </div>
      )}

      <div className="quiz-foot">
        {!submitted ? (
          <>
            <button
              type="button"
              className="quiz-btn quiz-btn-primary"
              data-testid="quiz-submit"
              disabled={!ready}
              onClick={handleSubmit}
            >
              {t('quiz.submit')}
            </button>
            <span className="quiz-progress" data-testid="quiz-progress">
              {t('quiz.answeredProgress', { done: answeredCount, total: quiz.questions.length })}
            </span>
          </>
        ) : (
          <button type="button" className="quiz-btn" data-testid="quiz-redo" onClick={handleRedo}>
            {t('quiz.redo')}
          </button>
        )}

        <button
          type="button"
          className="quiz-btn"
          data-testid="quiz-save-kb"
          disabled={!vaultId || saving}
          title={!vaultId ? t('quiz.saveNoVault') : undefined}
          onClick={handleSave}
        >
          {saving ? t('quiz.saving') : t('quiz.save')}
        </button>
        {savedPath && (
          <span className="quiz-saved" data-testid="quiz-saved-path">
            {t('quiz.saved', { path: savedPath })}
          </span>
        )}
        {saveError && <span className="quiz-error" role="alert">{saveError}</span>}
      </div>
    </div>
  );
}
