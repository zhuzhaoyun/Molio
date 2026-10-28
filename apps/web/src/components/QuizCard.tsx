import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { useActiveVaultId } from '../stores/vaultStore';
import { quizAnchorStore, useQuizAnswerAnchor } from '../stores/quizAnchorStore';
import { useQuizSubjects } from '../stores/quizSubjectStore';
import { anchorBelongsToQuestion, backfillAnchorFingerprint, gradingMapKey } from '../utils/quizAnswer';
import { useWikiLinkClick } from '../hooks/useWikiLinkClick';
import { CodeBlock } from './CodeBlock';
import { renderMarkdown } from '../utils/markdown';
import { preprocessLocalImages } from '../utils/kbImage';
import { saveQuizToVault } from '../utils/quizFile';
import {
  parseQuizBlock,
  gradeQuiz,
  isQuizComplete,
  isSubjectQuestion,
  computeQuizFingerprint,
  quizStorageKey,
  parseStoredQuizState,
  quizStemOf,
  MAX_QUIZ_KEY_CHARS,
  type InvalidQuestion,
  type Quiz,
  type QuizGrade,
  type QuizQuestion,
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
  const quizAnchor = useQuizAnswerAnchor();
  // 本会话的解答题状态（键 = 指纹:题号）：已作答 + 批改结果。两者都从会话
  // 消息序推导（作答发生在聊天输入框里，题卡本地无从得知）。
  const subjectStates = useQuizSubjects(conversationId);
  const [openGradingFor, setOpenGradingFor] = useState<string | null>(null);

  // 题干/选项/解析里的 ![alt](库内相对路径) 改写成 daemon raw URL 才能真正加载
  // （KB 查看器同款规则，见 utils/kbImage.ts）。无活跃库时保持原文。
  const renderQuizMarkdown = useCallback(
    (text: string) => renderMarkdown(vaultId ? preprocessLocalImages(text, vaultId) : text),
    [vaultId],
  );

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // 卡片身份（内容派生的 quiz 指纹前 8 位）：答题锚的归属判定键。
  const fingerprintKey = fingerprint?.slice(0, 8) ?? '';
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
  // 主观题不进本地判分批次（本地判不了开放题），但**要进进度统计**：
  // 统计口径 = 整张卷子的题数，否则「已作答 3/3」会漏掉解答题——用户看到
  // 的是一张 4 题的卷子，却被告已完成 3/3。
  const gradableQuestions = useMemo(
    () => quiz.questions.filter((question) => !isSubjectQuestion(question)),
    [quiz],
  );
  const answeredCount = gradableQuestions.filter(
    (question) => (selections[question.id]?.length ?? 0) > 0,
  ).length;
  // 解答题已作答数：从会话消息序推导（作答发生在聊天输入框），按指纹隔离
  // ——两张同有第 3 题的卡各自独立，互不串。
  const subjectAnsweredCount = useMemo(() => {
    if (!fingerprint || !subjectStates) return 0;
    const key8 = fingerprint.slice(0, 8);
    return quiz.questions.filter(
      (question, index) =>
        isSubjectQuestion(question)
        && subjectStates.answered.has(gradingMapKey(key8, index + 1)),
    ).length;
  }, [quiz, fingerprint, subjectStates]);
  const totalQuestionCount = quiz.questions.length;
  // 有没有「交卷」这一步：有客观题 → 有「提交答案」按钮；纯主观题卡没有
  // 客观题可交卷 → 没有这个动作（批改直接显示，否则这类卡永远揭晓不了）。
  const hasSubmitAffordance = gradableQuestions.length > 0;
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
  // 符号插入超限的输入框（红边 1.2s 反馈）。
  const [fullInputId, setFullInputId] = useState<string | null>(null);
  const fullInputTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (fullInputTimerRef.current) clearTimeout(fullInputTimerRef.current);
  }, []);

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
      // maxLength 管不住程序化 setValue：超限就拒绝插入，绝不截断——静默
      // 截断会毁掉答案。红边 1.2s 作为「为什么没插进去」的反馈。
      if (next.length > MAX_QUIZ_KEY_CHARS) {
        setFullInputId(questionId);
        if (fullInputTimerRef.current) clearTimeout(fullInputTimerRef.current);
        fullInputTimerRef.current = window.setTimeout(() => setFullInputId(null), 1200);
        return;
      }
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

  // 「作答」只负责挂/摘锚：题干与隐藏评分点在发送时物化进消息（见
  // ChatComposer + utils/quizAnswer.ts），题卡本身不收主观题答案。
  // 指纹是异步算出的：点击早于指纹就绪时，锚上 key 为空串——指纹一到
  // 就地补齐。归属认定与防环规则在 backfillAnchorFingerprint（内容所有权
  // + 只碰空 key）：不满足条件时返回 null，不做任何写入。
  useEffect(() => {
    if (!fingerprint || !quizAnchor) return;
    const healed = backfillAnchorFingerprint(quiz, fingerprint, quizAnchor);
    if (healed) quizAnchorStore.set(healed, quizAnchor.questionId);
  }, [fingerprint, quizAnchor, quiz]);

  const toggleSubjectAnchor = useCallback(
    (question: QuizQuestion, index: number) => {
      // 归属判定用「题号 + 卡片身份」（指纹），不能只用围栏内题号——两张卡
      // 几乎必然撞 id（「q3」）。用 id 会把 B 卡的锚误判成「当前题」→ 点第二
      // 张卡变成取消而不是换锚 → 作答静默失效（消息不带物化块）。
      if (anchorBelongsToQuestion(quizAnchor?.anchor, question, fingerprintKey, index + 1)) {
        quizAnchorStore.clear();
        return;
      }
      quizAnchorStore.set(
        {
          questionIndex: index + 1,
          typeLabel: t('quiz.type.subject'),
          stem: question.stem,
          points: question.answer,
          sources: question.sources.map((source) => source.path),
          // 物化 v2 的「题目指纹」行来源：批改回写题卡的关联键（前 8 位）。
          fingerprintKey: fingerprintKey,
        },
        question.id,
      );
    },
    [quizAnchor, fingerprintKey, t],
  );

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
        const isSubject = isSubjectQuestion(question);
        const subjectKey = fingerprintKey ? gradingMapKey(fingerprintKey, index + 1) : null;
        const subjectGrading = isSubject && subjectKey
          ? subjectStates?.gradings.get(subjectKey) ?? null
          : null;
        const subjectAnswered = isSubject && subjectKey
          ? subjectStates?.answered.has(subjectKey) ?? false
          : false;
        // 「作答」按钮的 .on 态：锚属于**这张卡的这道题**（题号 + 卡片身份），
        // 不能只看围栏内题号——两张卡几乎必然撞 id。
        const isAnchorOnThisQuestion = isSubject
          && anchorBelongsToQuestion(quizAnchor?.anchor, question, fingerprintKey, index + 1);
        // 揭晓门槛：批改结果与客观题判分**同批揭晓**——点「提交答案」前只显示
        // 状态徽标（已作答/已批改），分数与逐点详情交卷后才出现。整张卷子一
        // 次交卷、一次揭晓，与真实试卷一致。交卷后到达的批改照常显示。
        // 纯主观题卡没有交卷动作（hasSubmitAffordance=false）→ 批改直接显示，
        // 否则这类卡的批改永远不会出现。
        const revealSubjectGrading = submitted || !hasSubmitAffordance;
        return (
          <div className="quiz-question" data-testid="quiz-question" data-question-id={question.id} key={question.id}>
            <div className="quiz-question-head">
              <span className="quiz-index">{t('quiz.question', { n: index + 1 })}</span>
              <span className="quiz-type" data-testid="quiz-type">{t(`quiz.type.${question.type}`)}</span>
              {grade && !isSubject && (
                <span
                  className={`quiz-result ${grade.correct ? 'correct' : 'wrong'}`}
                  data-testid="quiz-result"
                  data-correct={grade.correct ? 'true' : 'false'}
                >
                  {grade.correct ? t('quiz.correct') : t('quiz.wrong')}
                </span>
              )}
              {/* 解答题状态徽标：与客观题的「正确/错误」徽标同一位置、同一语义
               * ——交卷前只说「已作答/已批改」，交卷后才给分数。批改还没到达
               * 时也显示（否则纯解答题卡在等待期里这一行什么都不显示）。 */}
              {isSubject && subjectAnswered && !(subjectGrading && revealSubjectGrading) && (
                <span
                  className="quiz-subject-status"
                  data-testid="quiz-subject-status"
                  data-state={subjectGrading ? 'graded' : 'answered'}
                >
                  {subjectGrading ? t('quiz.subjectGraded') : t('quiz.subjectAnswered')}
                </span>
              )}
              {/* 大题批改回写：得分徽标（数字通用，判定详情折叠在行内）。 */}
              {isSubject && subjectGrading && revealSubjectGrading && (
                <span
                  className="quiz-subject-score"
                  data-testid="quiz-subject-score"
                  title={t('quiz.grading.pointsTitle')}
                >
                  {subjectGrading.score}/{subjectGrading.total}
                </span>
              )}
            </div>

            {/* 题干走受控 markdown（renderMarkdown 先转义 HTML）：图片/加粗/
                上下标等才能显示；`____` 空位标记不受强调语法影响。 */}
            <div
              className="quiz-stem"
              data-testid="quiz-stem"
              dangerouslySetInnerHTML={{ __html: renderQuizMarkdown(question.stem) }}
            />

            {isSubject && (
              /* 主观题行：无选项/无本地判分/无重做——作答走问答输入框，
               * 按钮只负责挂/摘锚（发送时物化题干+隐藏评分点）。 */
              <div className="quiz-subject-actions">
                <button
                  type="button"
                  className={`quiz-btn quiz-answer-btn${isAnchorOnThisQuestion ? ' on' : ''}`}
                  data-testid="quiz-answer-btn"
                  data-question-id={question.id}
                  aria-pressed={isAnchorOnThisQuestion}
                  onClick={() => toggleSubjectAnchor(question, index)}
                >
                  {t('quiz.answerButton')}
                </button>
              </div>
            )}
            {isSubject && subjectGrading && revealSubjectGrading && (
              <div className="quiz-subject-points" data-testid="quiz-subject-points">
                <button
                  type="button"
                  className="quiz-subject-points-toggle"
                  data-testid="quiz-subject-points-toggle"
                  aria-expanded={openGradingFor === question.id}
                  onClick={() => setOpenGradingFor((prev) => (prev === question.id ? null : question.id))}
                >
                  {t('quiz.grading.pointsTitle')}
                  <span className="quiz-subject-points-caret">{openGradingFor === question.id ? '▾' : '▸'}</span>
                </button>
                {openGradingFor === question.id && (
                  <div className="quiz-subject-points-list">
                    {subjectGrading.points.map((point, pointIndex) => (
                      <div className="quiz-subject-point" data-testid="quiz-subject-point" key={pointIndex}>
                        <span className={`quiz-subject-point-status ${point.status}`}>
                          {t(`quiz.grading.${point.status}`)}
                        </span>
                        <span
                          className="quiz-subject-point-text"
                          dangerouslySetInnerHTML={{ __html: renderQuizMarkdown(point.text) }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!isSubject && (
              <div className="quiz-options">
              {question.type === 'fill' ? (
                /* 填空：文本作答。判分在 gradeQuiz 里做规范化匹配（含 ASCII 记法折叠）；
                 * 64 上限与 daemon chosen 逐项上限一致，超长会落不了库。 */
                <div className="quiz-fill" data-fill-scope={question.id}>
                  <div className="quiz-input-row">
                    <input
                      ref={(el) => { fillInputRefs.current[question.id] = el; }}
                      className={`quiz-fill-input${fullInputId === question.id ? ' quiz-fill-input--full' : ''}`}
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
                      dangerouslySetInnerHTML={{ __html: renderQuizMarkdown(option.text) }}
                    />
                  </button>
                );
              })}
              </div>
            )}

            {grade && !isSubject && (
              <div className="quiz-answer" data-testid="quiz-answer">
                {t('quiz.answer', { answer: question.answer.join(' / ') })}
              </div>
            )}

            {grade && !isSubject && (
              <div className="quiz-explanation" data-testid="quiz-explanation">
                <div className="quiz-section-label">{t('quiz.explanation')}</div>
                {/* renderMarkdown 先转义 HTML，再生成受控标签。 */}
                <div dangerouslySetInnerHTML={{ __html: renderQuizMarkdown(question.explanation) }} />
              </div>
            )}

            {grade && !isSubject && question.sources.length > 0 && (
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
        {hasSubmitAffordance && (
          !submitted ? (
            <button
              type="button"
              className="quiz-btn quiz-btn-primary"
              data-testid="quiz-submit"
              disabled={!ready}
              onClick={handleSubmit}
            >
              {t('quiz.submit')}
            </button>
          ) : (
            <button
              type="button"
              className="quiz-btn"
              data-testid="quiz-redo"
              title={t('quiz.redoTitle')}
              onClick={handleRedo}
            >
              {t('quiz.redo')}
            </button>
          )
        )}
        {/* 进度始终显示（口径 = 整张卷子：解答题答了就算已作答）。交卷后
            按钮换成「重做」，但计数留着——交卷那一刻正是用户想看「答了几题」。 */}
        {totalQuestionCount > 0 && (
          <span className="quiz-progress" data-testid="quiz-progress">
            {t('quiz.answeredProgress', {
              done: answeredCount + subjectAnsweredCount,
              total: totalQuestionCount,
            })}
          </span>
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
