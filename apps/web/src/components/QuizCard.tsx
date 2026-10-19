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

/**
 * Quiz 交互块（交互块注册表的第一个块）。
 *
 * 只解析 JSON，不执行任何代码；题干/选项/解析都由 React 文本节点渲染。
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

  const handleSubmit = useCallback(() => {
    if (!ready || submitted) return;
    setSubmitted(true);

    // 本地判分已完成；落库失败不阻塞用户看结果。
    if (fingerprint) {
      const attempts = gradeQuiz(quiz, selections).map((grade) => ({
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
              <span className="quiz-type">{t(`quiz.type.${question.type}`)}</span>
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

            <div className="quiz-stem" data-testid="quiz-stem">{question.stem}</div>

            <div className="quiz-options">
              {question.options.map((option) => {
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
                    <span className="quiz-option-text">{option.text}</span>
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
