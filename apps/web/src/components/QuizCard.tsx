import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { useActiveVaultId, useVaults } from '../stores/vaultStore';
import { useQuizSubjects } from '../stores/quizSubjectStore';
import {
  buildQuizSubmissionMessage,
  mergeSubjectDrafts,
  subjectImageMarkdown,
  gradingMapKey,
  type SubjectAnswerEntry,
} from '../utils/quizAnswer';
import { useWikiLinkClick } from '../hooks/useWikiLinkClick';
import { useFileNavigation } from '../hooks/useFileNavigation';
import { isRevealAvailable, revealInFolder } from '../utils/reveal';
import { CodeBlock } from './CodeBlock';
import { renderMarkdown } from '../utils/markdown';
import { preprocessLocalImages } from '../utils/kbImage';
import { saveQuizToVault, type QuizFileInput } from '../utils/quizFile';
import {
  buildQuizFileQuestions,
  classifyQuestions,
  pickDefaultScope,
  selectForSave,
  type QuizSaveContext,
  type QuizSaveScope,
} from '../utils/quizSaveScope';
import {
  parseQuizBlock,
  gradeQuiz,
  countQuizAnswered,
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

/** 存档结果行的动作按钮存活时长（与 SaveToKbButton 的反馈窗一致）。 */
const SAVE_ACTIONS_WINDOW_MS = 6000;

interface Props {
  /** JSON text inside the ```quiz fence. */
  raw: string;
  /** False while the closing fence has not arrived yet. */
  complete: boolean;
  /** True when the containing assistant message is still streaming. */
  streaming?: boolean;
  /** Used for localStorage scoping. */
  conversationId?: string | null;
  /** 会话所属库（daemon 的 conversations.vault_id）；取不到时回落活动库。 */
  conversationVaultId?: string | null;
  /** 整卷交卷：宿主发送链（ChatSessionView 的 onSubmitForm → handleSend 兜底）。
   *  undefined = 宿主不可达（无 runtime 的替换区等）→ 含解答草稿时禁用交卷。 */
  onSubmitPaper?: (message: string) => void;
  /** 宿主发送链当前不可用（无可用 runtime / composer 被整块替换）。 */
  paperSubmitDisabled?: boolean;
  /** 会话级 run 是否进行中（批改中 pill 的呼吸态依据；run 结束仍无回写 → 「已交卷」）。 */
  conversationRunning?: boolean;
}

/** 填空符号托盘：通用难输入字符（理工科一期组）。分组与后置项依据
 *  docs/2026-10-24-quiz-fill-input-domains.md（文科/小语种组后续按需追加）。 */
/** 列表里的一行题面：去掉图片语法与强调标记，压成单行（CSS 再负责省略号）。 */
function previewStem(stem: string): string {
  return stem
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
export function QuizCard({ raw, complete, streaming, conversationId, conversationVaultId, onSubmitPaper, paperSubmitDisabled, conversationRunning }: Props) {
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
      conversationVaultId={conversationVaultId}
      onSubmitPaper={onSubmitPaper}
      paperSubmitDisabled={paperSubmitDisabled}
      conversationRunning={conversationRunning}
    />
  );
}

function QuizBody({
  quiz,
  invalidQuestions,
  conversationId,
  conversationVaultId,
  onSubmitPaper,
  paperSubmitDisabled,
  conversationRunning,
}: {
  quiz: Quiz;
  invalidQuestions: InvalidQuestion[];
  conversationId?: string | null;
  conversationVaultId?: string | null;
  onSubmitPaper?: (message: string) => void;
  paperSubmitDisabled?: boolean;
  conversationRunning?: boolean;
}) {
  const { t } = useI18n();
  // 会话所属库优先：历史会话跨库打开时，活动库不是它自己的库。取不到
  // （老 daemon / 会话已删 / 首轮消息还没落库）再回落活动库。卡内传图走同一
  // 归属（uploadAsset 落会话库，不是活动库硬编码——跨库历史会话传错库会裂图）。
  const activeVaultId = useActiveVaultId();
  const vaultId = conversationVaultId ?? activeVaultId;
  const handleWikiLinkClick = useWikiLinkClick();
  // 本会话的解答题状态（键 = 指纹:题号）：已作答 + 批改结果。都从会话消息序
  // 推导——交卷消息与批改回复是消息流里的事实，历史刷新后重算即可回写。
  const subjectStates = useQuizSubjects(conversationId);
  const [openGradingFor, setOpenGradingFor] = useState<string | null>(null);

  // 题干/选项/解析里的 ![alt](库内相对路径) 改写成 daemon raw URL 才能真正加载
  // （KB 查看器同款规则，见 utils/kbImage.ts）。无活跃库时保持原文。
  const renderQuizMarkdown = useCallback(
    (text: string) => renderMarkdown(vaultId ? preprocessLocalImages(text, vaultId) : text),
    [vaultId],
  );

  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // 卡片身份（内容派生的 quiz 指纹前 8 位）：解答题状态/批改回写的关联键。
  const fingerprintKey = fingerprint?.slice(0, 8) ?? '';
  const [selections, setSelections] = useState<QuizSelections>({});
  // 解答题草稿图（题目 id → vault 相对路径）：与 selections/submitted 同键持久化。
  const [subjectImages, setSubjectImages] = useState<Record<string, string[]>>({});
  const [submitted, setSubmitted] = useState(false);
  // 未答完确认条（amber）：点提交且还有空题时展开，「仍要交卷」二次放行。
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 卡内传图：上传中的题（按钮禁用）＋ 失败的题（工具行旁提示）。
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [uploadErrorFor, setUploadErrorFor] = useState<string | null>(null);
  // 存档：面板 + 范围 + 勾选。错题优先是默认，但永远由用户按下确认才写盘。
  const [saveOpen, setSaveOpen] = useState(false);
  const [scope, setScope] = useState<QuizSaveScope>('wrong');
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [saving, setSaving] = useState(false);
  // setState 是异步的：连点两次时第二次进来 saving 仍是 false，会写两份文件。
  const savingRef = useRef(false);
  const [saved, setSaved] = useState<{ path: string; count: number } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const undoRef = useRef(false);
  // 结果行的动作按钮只开 6s 反馈窗（与 SaveToKbButton 一致：2.5s 对非技术用户太短，
  // 但不能常驻——写盘是低频动作，留下来会一直占着卡片底部）。窗口过后只剩一行静态路径。
  const [saveActionsVisible, setSaveActionsVisible] = useState(false);
  const saveActionsTimerRef = useRef<number | null>(null);
  const restoredKeyRef = useRef<string | null>(null);

  const grades = useMemo(
    () => (submitted ? gradeQuiz(quiz, selections) : []),
    [submitted, quiz, selections],
  );
  const gradeMap = useMemo(
    () => new Map<string, QuizGrade>(grades.map((grade) => [grade.questionId, grade])),
    [grades],
  );

  // 解答题草稿（M1 表单语义）：文本与 fill 同形（selections[qid]=[text]），
  // 图片单独存 subjectImages；body = 文本 + 图片 markdown 行。
  const subjectHasDraft = useCallback(
    (questionId: string) =>
      (selections[questionId]?.[0] ?? '').trim().length > 0
      || (subjectImages[questionId]?.length ?? 0) > 0,
    [selections, subjectImages],
  );

  // 整卷交卷消息的物化输入：只携带**当前草稿**（旧会话消息里推导已答的题
  // 不重新物化——消息是事实，不重演）。
  const subjectEntries = useMemo<SubjectAnswerEntry[]>(() => {
    if (!fingerprint) return [];
    const key8 = fingerprint.slice(0, 8);
    const entries: SubjectAnswerEntry[] = [];
    for (const [index, question] of quiz.questions.entries()) {
      if (!isSubjectQuestion(question)) continue;
      const body = [
        (selections[question.id]?.[0] ?? '').trim(),
        subjectImageMarkdown(subjectImages[question.id] ?? []),
      ].filter(Boolean).join('\n');
      if (!body) continue;
      entries.push({
        questionIndex: index + 1,
        stem: question.stem,
        points: question.answer,
        sources: question.sources.map((source) => source.path),
        fingerprintKey: key8,
        body,
      });
    }
    return entries;
  }, [quiz, selections, subjectImages, fingerprint]);

  // 草稿 ∪ 消息推导的解答题正文（回显 / 存为题库共用数据源；同键草稿优先）。
  const mergedSubjectBodies = useMemo(
    () => mergeSubjectDrafts(
      quiz,
      selections,
      subjectImages,
      subjectStates?.answers ?? new Map(),
      fingerprintKey,
    ),
    [quiz, selections, subjectImages, subjectStates, fingerprintKey],
  );

  // 进度口径 = 整张卷子：草稿 ∪ 旧会话推导已答（锚时代会话重开时进度不丢）。
  const answeredCount = useMemo(() => {
    let count = countQuizAnswered(quiz, selections);
    if (fingerprint && subjectStates) {
      const key8 = fingerprint.slice(0, 8);
      for (const [index, question] of quiz.questions.entries()) {
        if (!isSubjectQuestion(question)) continue;
        const hasDraft = subjectHasDraft(question.id);
        if (!hasDraft && subjectStates.answered.has(gradingMapKey(key8, index + 1))) count += 1;
      }
    }
    return count;
  }, [quiz, selections, fingerprint, subjectStates, subjectHasDraft]);

  const totalQuestionCount = quiz.questions.length;
  const unansweredCount = totalQuestionCount - answeredCount;
  const storageKey =
    fingerprint && conversationId ? quizStorageKey(conversationId, fingerprint) : null;

  // 批改待回的解答题数（已答[草稿或推导]但批改未到）：>0 且 run 活动中 →
  // foot 显示「批改中」占位；run 结束仍缺 → 停「已交卷」pill，不卡死。
  const subjectPendingCount = useMemo(() => {
    if (!fingerprint) return 0;
    const key8 = fingerprint.slice(0, 8);
    let count = 0;
    for (const [index, question] of quiz.questions.entries()) {
      if (!isSubjectQuestion(question)) continue;
      const key = gradingMapKey(key8, index + 1);
      const answered = subjectHasDraft(question.id) || (subjectStates?.answered.has(key) ?? false);
      if (answered && !(subjectStates?.gradings.has(key) ?? false)) count += 1;
    }
    return count;
  }, [quiz, fingerprint, subjectHasDraft, subjectStates]);

  // 提交门槛：≥1 题已答（可交白卷的对称面——全空白卷没有可判分的内容）。
  // 含解答草稿时还要求：指纹就绪（物化要带指纹行）且宿主发送链可用。
  const paperNeeded = subjectEntries.length > 0;
  const submitDisabled =
    answeredCount === 0
    || (paperNeeded && (paperSubmitDisabled || !fingerprint));
  const submitDisabledTitle =
    paperNeeded && paperSubmitDisabled ? t('quiz.submitNoRuntimeTitle') : undefined;

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
    setSubjectImages({});
    setConfirmOpen(false);
    try {
      const stored = parseStoredQuizState(localStorage.getItem(storageKey));
      if (stored) {
        setSelections(stored.selections);
        setSubmitted(stored.submitted);
        setSubjectImages(stored.subjectImages);
      }
    } catch {
      // localStorage 不可用（隐私模式等）→ 只在内存里作答。
    }
    restoredKeyRef.current = storageKey;
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || restoredKeyRef.current !== storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ selections, submitted, subjectImages }));
    } catch {
      // 配额/隐私模式：不阻塞答题。
    }
  }, [storageKey, selections, submitted, subjectImages]);

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

  // 填空作答与解答题草稿同一收口：空文本存空数组（已答计数据此判未作答）。
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

  // ── 整卷交卷（提交即快照：批改只发生在交卷消息上）────────────────────────
  const doSubmit = useCallback(() => {
    setConfirmOpen(false);
    setSubmitted(true);

    // 本地判分已完成；落库失败不阻塞用户看结果。
    // 空/超长 chosen 不进批次：daemon 对两者整批拒绝，会把整次提交的答题
    // 记录全部丢掉。超长只可能来自被改过的 localStorage（正常输入被
    // maxLength 挡住），丢弃该题保住其余题目的落库。纯解答卷（无客观已答）
    // attempts 为空 → 不发落库请求（daemon 对空批次整批拒绝）。
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
      if (attempts.length > 0) {
        void api.saveQuizAttempts({
          vaultId: vaultId ?? null,
          quizFingerprint: fingerprint,
          conversationId: conversationId ?? null,
          attempts,
        }).catch(() => {
          // 一期不向用户暴露落库失败：答题体验优先，错题本/统计是二期能力。
        });
      }
    }

    // 解答题物化成一条交卷消息（首行给人读），走宿主发送链——与普通消息
    // 同一条路：run 进行中就排队，错误在消息流里出现。entries 空（纯客观卷
    // /解答题全空）→ 不发消息、不建 run，只做本地判分。
    const paperMessage = buildQuizSubmissionMessage(quiz.title, subjectEntries);
    if (paperMessage) onSubmitPaper?.(paperMessage);
  }, [fingerprint, quiz, selections, vaultId, conversationId, subjectEntries, onSubmitPaper]);

  const handleSubmit = useCallback(() => {
    if (submitted || answeredCount === 0) return;
    if (paperNeeded && (!fingerprint || paperSubmitDisabled)) return;
    // 未答完交卷（考试心智：可交白卷）：先展开 amber 确认条说后果，
    // 「仍要交卷」二次放行——不打断，也不静默。
    if (unansweredCount > 0) {
      setConfirmOpen(true);
      return;
    }
    doSubmit();
  }, [submitted, answeredCount, paperNeeded, fingerprint, paperSubmitDisabled, unansweredCount, doSubmit]);

  const handleRedo = useCallback(() => {
    setSelections({});
    setSubjectImages({});
    setSubmitted(false);
    setConfirmOpen(false);
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  }, [storageKey]);

  // ── 解答题卡内作答：上传 / 符号 / 粘贴 ───────────────────────────────────
  const uploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const subjectInputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const uploadAnswerImage = useCallback(async (questionId: string, file: File) => {
    if (!vaultId || uploadingFor) return;
    setUploadErrorFor(null);
    setUploadingFor(questionId);
    try {
      const { filePath } = await api.uploadAsset(vaultId, file);
      setSubjectImages((prev) => ({
        ...prev,
        [questionId]: [...(prev[questionId] ?? []), filePath],
      }));
    } catch {
      setUploadErrorFor(questionId);
    } finally {
      setUploadingFor(null);
    }
  }, [vaultId, uploadingFor]);

  // 粘贴图片直接进作答（桌面拍照/截图工作流）：只拦图片文件，文本粘贴照常。
  const handleSubjectPaste = useCallback(
    (questionId: string, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      event.preventDefault();
      for (const file of files) void uploadAnswerImage(questionId, file);
    },
    [uploadAnswerImage],
  );

  // 符号插入（textarea 版）：与 fill 同款光标插入，但**不设 64 上限**——那是
  // daemon chosen 的契约，只约束填空；解答题正文没有长度上限。
  const insertSubjectSymbol = useCallback(
    (questionId: string, char: string) => {
      if (submitted) return;
      const input = subjectInputRefs.current[questionId];
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

  // auto-grow：空态一行高（≈48px），输入随内容生长，320px 封顶后内部滚动。
  const growTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(320, Math.max(48, el.scrollHeight))}px`;
  }, []);

  // 保存口径从同一份上下文派生（判定三态 / 作答正文 / 批改分数）。
  const saveContext = useMemo<QuizSaveContext>(() => ({
    submitted,
    grades,
    subjectGradings: subjectStates?.gradings ?? new Map(),
    fingerprintKey,
  }), [submitted, grades, subjectStates, fingerprintKey]);

  const candidates = useMemo(() => classifyQuestions(quiz, saveContext), [quiz, saveContext]);
  const wrongCount = candidates.filter((candidate) => candidate.outcome === 'wrong').length;
  // 没有错题时「只存做错的」会是空集：静默退回全部，而不是让用户按下一个 0 题按钮。
  const effectiveScope: QuizSaveScope = scope === 'wrong' && wrongCount === 0 ? 'all' : scope;
  const selected = useMemo(
    () => selectForSave(candidates, effectiveScope, picked),
    [candidates, effectiveScope, picked],
  );
  const targetVault = useVaults().find((vault) => vault.id === vaultId);
  const vaultName = targetVault?.name ?? '';
  // 「在资源管理器中显示」只在桌面壳里成立（浏览器 / NAS 远程访问没有这个能力）
  const revealReady = isRevealAvailable() && !!targetVault?.path;
  const { openFile } = useFileNavigation();

  const openSavePanel = useCallback(() => {
    setScope(pickDefaultScope(candidates));
    setPicked(new Set(candidates.filter((c) => c.outcome === 'wrong').map((c) => c.index)));
    setSaveError(null);
    setSaveOpen(true);
  }, [candidates]);

  const chooseScope = useCallback((next: QuizSaveScope) => {
    // 切到「自己挑」时用错题预勾：用户多半是在默认集合上做增减。
    setPicked((prev) => (next === 'pick' && prev.size === 0
      ? new Set(candidates.filter((c) => c.outcome === 'wrong').map((c) => c.index))
      : prev));
    setScope(next);
  }, [candidates]);

  const togglePicked = useCallback((index: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const clearSaveActionsTimer = useCallback(() => {
    if (saveActionsTimerRef.current !== null) {
      window.clearTimeout(saveActionsTimerRef.current);
      saveActionsTimerRef.current = null;
    }
  }, []);

  // 卸载时清定时器：卡片随消息流销毁后别再 setState。
  useEffect(() => clearSaveActionsTimer, [clearSaveActionsTimer]);

  const handleSave = useCallback(async () => {
    if (!vaultId || savingRef.current || selected.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const input: QuizFileInput = {
        title: quiz.title,
        version: quiz.version,
        fingerprint,
        totalQuestions: quiz.questions.length,
        questions: buildQuizFileQuestions(
          quiz,
          selected,
          saveContext,
          selections,
          mergedSubjectBodies,
        ),
      };
      const path = await saveQuizToVault(vaultId, input, api);
      setSaved({ path, count: selected.length });
      setSaveOpen(false);
      setSaveActionsVisible(true);
      clearSaveActionsTimer();
      saveActionsTimerRef.current = window.setTimeout(
        () => setSaveActionsVisible(false),
        SAVE_ACTIONS_WINDOW_MS,
      );
    } catch {
      setSaveError(t('quiz.saveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [vaultId, selected, quiz, fingerprint, saveContext, selections, mergedSubjectBodies, t, clearSaveActionsTimer]);

  // 撤销 = 删掉刚写的那份文件。只在写盘成功后出现，删除成功即收起结果行；
  // 失败保留结果行并说明原因（用户仍可以自己去库里删）。
  const handleUndo = useCallback(async () => {
    if (!vaultId || !saved || undoRef.current) return;
    undoRef.current = true;
    setUndoing(true);
    setUndoError(null);
    try {
      await api.deleteFile(vaultId, saved.path);
      setSaved(null);
    } catch {
      setUndoError(t('quiz.undoFailed'));
    } finally {
      undoRef.current = false;
      setUndoing(false);
    }
  }, [vaultId, saved, t]);

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
        // 解答题题级状态（M1 表单语义）：
        // - 交卷前：推导已答（旧会话）→ 「已作答」；本地草稿 → 无 pill（进度条已表达）。
        // - 交卷后：批改到达 → 得分徽标；空题 → 「未作答」；否则 run 活动期
        //   「批改中」（呼吸点）、run 结束仍无回写 → 「已交卷」（无卡死态）。
        const subjectDrafted = isSubject && subjectHasDraft(question.id);
        const subjectUnanswered = isSubject && !subjectAnswered && !subjectDrafted;
        const subjectPillState = subjectGrading
          ? null
          : subjectUnanswered
            ? 'unanswered'
            : conversationRunning
              ? 'grading'
              : 'awaiting';
        // 回显（只读）：交卷后用草稿镜像（消息可能还在排队——不等消息落库
        // 就能看回自己答了什么）；旧会话推导已答且无本地草稿 → 同款回显。
        const subjectEchoBody = isSubject && subjectKey
          && (submitted || (subjectAnswered && !subjectDrafted))
          ? mergedSubjectBodies.get(subjectKey) ?? ''
          : '';
        return (
          <div className="quiz-question" data-testid="quiz-question" data-question-id={question.id} key={question.id}>
            <div className="quiz-question-head">
              <span className="quiz-index">{t('quiz.question', { n: index + 1 })}</span>
              <span className="quiz-type" data-testid="quiz-type">{t(`quiz.type.${question.type}`)}</span>
              {grade && !isSubject && grade.chosen.length > 0 && (
                <span
                  className={`quiz-result ${grade.correct ? 'correct' : 'wrong'}`}
                  data-testid="quiz-result"
                  data-correct={grade.correct ? 'true' : 'false'}
                >
                  {grade.correct ? t('quiz.correct') : t('quiz.wrong')}
                </span>
              )}
              {/* 解答题状态 pill：交卷前推导已答说「已作答」、已有批改说「已批改」
               * （分数仍留给交卷揭晓）；交卷后未批改的题按 未作答/批改中/已交卷
               * 三态显示（中性色，不透露判定）。 */}
              {isSubject && !submitted && subjectGrading && (
                <span
                  className="quiz-subject-status"
                  data-testid="quiz-subject-status"
                  data-state="graded"
                >
                  {t('quiz.subjectGraded')}
                </span>
              )}
              {isSubject && !subjectGrading && !submitted && subjectAnswered && (
                <span
                  className="quiz-subject-status"
                  data-testid="quiz-subject-status"
                  data-state="answered"
                >
                  {t('quiz.subjectAnswered')}
                </span>
              )}
              {isSubject && !subjectGrading && submitted && subjectPillState && (
                <span
                  className={`quiz-subject-status${subjectPillState === 'grading' ? ' grading' : ''}`}
                  data-testid="quiz-subject-status"
                  data-state={subjectPillState}
                >
                  {subjectPillState === 'grading' && <span className="quiz-grading-dot" aria-hidden />}
                  {subjectPillState === 'unanswered'
                    ? t('quiz.subjectUnanswered')
                    : subjectPillState === 'grading'
                      ? t('quiz.subjectGrading')
                      : t('quiz.subjectAwaiting')}
                </span>
              )}
              {/* 大题批改回写：得分徽标（数字通用，判定详情折叠在行内）。 */}
              {isSubject && subjectGrading && submitted && (
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

            {isSubject && subjectEchoBody ? (
              /* 你的作答（只读回显）：交卷后作答区换安静面板；图片以行内
               * 44px 高度还原（renderQuizMarkdown 已把库内路径改写为 raw URL）。 */
              <div className="quiz-subject-echo" data-testid="quiz-subject-echo">
                <div className="quiz-subject-echo-label">{t('quiz.yourAnswerLabel')}</div>
                <div dangerouslySetInnerHTML={{ __html: renderQuizMarkdown(subjectEchoBody) }} />
              </div>
            ) : isSubject ? (
              /* 解答题作答区：fill 输入行的多行放大。容器内三层——textarea
               * （auto-grow）/ 附件缩略图条 / 工具行（符号 + 插入图片）。 */
              <div className="quiz-subject-input-row" data-fill-scope={question.id}>
                <textarea
                  ref={(el) => { subjectInputRefs.current[question.id] = el; growTextarea(el); }}
                  className="quiz-subject-textarea"
                  data-testid="quiz-subject-input"
                  data-question-id={question.id}
                  value={chosen[0] ?? ''}
                  placeholder={t('quiz.subjectAnswerPlaceholder')}
                  aria-label={t('quiz.subjectAnswerPlaceholder')}
                  disabled={submitted}
                  onChange={(event) => { setFillText(question.id, event.target.value); growTextarea(event.target); }}
                  onPaste={(event) => handleSubjectPaste(question.id, event)}
                />
                {(subjectImages[question.id]?.length ?? 0) > 0 && (
                  <div className="quiz-answer-assets" data-testid="quiz-answer-assets">
                    {(subjectImages[question.id] ?? []).map((path, imageIndex) => (
                      <span className="quiz-asset-thumb" key={`${path}-${imageIndex}`}>
                        <img src={vaultId ? api.rawFileUrl(vaultId, path) : undefined} alt="" loading="lazy" />
                        {!submitted && (
                          <button
                            type="button"
                            className="quiz-asset-remove"
                            data-testid="quiz-asset-remove"
                            aria-label={t('quiz.removeImage')}
                            onClick={() => setSubjectImages((prev) => ({
                              ...prev,
                              [question.id]: (prev[question.id] ?? []).filter((_, i) => i !== imageIndex),
                            }))}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                <div className="quiz-subject-toolbar">
                  <button
                    type="button"
                    className={`quiz-subject-tool${openSymbolsFor === question.id ? ' on' : ''}`}
                    data-testid="quiz-subject-symbol"
                    aria-expanded={openSymbolsFor === question.id}
                    disabled={submitted}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setOpenSymbolsFor((prev) => (prev === question.id ? null : question.id))}
                  >
                    {t('quiz.symbolTrigger')}
                  </button>
                  <button
                    type="button"
                    className="quiz-subject-tool"
                    data-testid="quiz-subject-upload"
                    disabled={submitted || uploadingFor === question.id}
                    onClick={() => uploadInputRefs.current[question.id]?.click()}
                  >
                    {uploadingFor === question.id ? t('quiz.uploading') : t('quiz.insertImage')}
                  </button>
                  {uploadErrorFor === question.id && (
                    <span className="quiz-upload-error" role="alert">{t('quiz.uploadFailed')}</span>
                  )}
                  <input
                    ref={(el) => { uploadInputRefs.current[question.id] = el; }}
                    data-testid="quiz-subject-file"
                    data-question-id={question.id}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadAnswerImage(question.id, file);
                      event.target.value = '';
                    }}
                  />
                </div>
                {openSymbolsFor === question.id && (
                  /* 解答题符号托盘：复用 fill 的四组通用难输入字符；文档流内
                   * 手风琴展开，不盖下一题（同 fill 的防误触设计）。必须在
                   * data-fill-scope 容器内——外点关闭器靠它豁免托盘内的按下。 */
                  <div className="quiz-symbol-tray" data-testid="quiz-subject-symbol-tray">
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
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => insertSubjectSymbol(question.id, char)}
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
            ) : null}
            {isSubject && subjectGrading && submitted && (
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
                // 提交后两条信息解耦到两个通道：标记（picked）只表达「我选了」，
                // 绿/红颜色只表达「对不对」。单选靠红/绿就能反推自己的选择，多选
                // 不行——「答案里有但没选」（漏选）与「选了且选对」都是绿色，没有
                // 选中标记就无从区分。chosen 提交后冻结，标记天然持久。
                // 标记形状承载结果（真机反馈：错选挂 ✓ 会被对勾的固有含义误读成
                // 「正确」）：✓＝选对、✗＝选错、无标＝没选，与 CSS ::before 同形。
                const picked = submitted && on;
                const className = [
                  'quiz-option',
                  on ? 'on' : '',
                  submitted && isAnswer ? 'correct' : '',
                  submitted && on && !isAnswer ? 'wrong' : '',
                  picked ? 'picked' : '',
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
                    data-picked={picked ? 'true' : 'false'}
                    data-mark={picked ? (isAnswer ? '✓' : '✗') : undefined}
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

            {/* 「你的答案」行：与「正确答案」同格式并排。chosen 来自判分结果
             * （contracts gradeQuiz 已去重排序），与判分口径同一份真相。只给
             * 选项型客观题（single/multiple/judge）：填空的作答原文留在上方
             * 输入框里可见，再印一行是重复；大题有自己的「你的答案」正文。 */}
            {grade && !isSubject && question.type !== 'fill' && grade.chosen.length > 0 && (
              <div className="quiz-your-answer" data-testid="quiz-your-answer">
                {t('quiz.yourAnswer', { answer: grade.chosen.join(' / ') })}
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
        {!submitted ? (
          <button
            type="button"
            className="quiz-btn quiz-btn-primary"
            data-testid="quiz-submit"
            disabled={submitDisabled}
            title={submitDisabledTitle}
            onClick={handleSubmit}
          >
            {t('quiz.submit')}
          </button>
        ) : paperNeeded && conversationRunning && subjectPendingCount > 0 ? (
          /* 批改中占位（非交互）：客观题已揭晓，主观等批改流式回流。
           * run 结束仍无回写的题停在「已交卷」pill，不卡死。 */
          <span className="quiz-grading-inline" data-testid="quiz-grading-inline">
            <span className="quiz-grading-dot" aria-hidden />
            {t('quiz.gradingPending')}
          </span>
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
        )}
        {/* 未答完确认条：amber（提醒而非报错），文案说后果；通栏展开在 foot 内。 */}
        {confirmOpen && !submitted && (
          <div className="quiz-submit-confirm" role="alert" data-testid="quiz-submit-confirm">
            <span>{t('quiz.confirmUnanswered', { n: unansweredCount })}</span>
            <span className="quiz-submit-confirm-actions">
              <button
                type="button"
                className="quiz-btn"
                data-testid="quiz-confirm-continue"
                onClick={() => setConfirmOpen(false)}
              >
                {t('quiz.continueAnswering')}
              </button>
              <button
                type="button"
                className="quiz-btn quiz-btn-primary"
                data-testid="quiz-confirm-submit"
                onClick={doSubmit}
              >
                {t('quiz.submitAnyway')}
              </button>
            </span>
          </div>
        )}
        {/* 进度始终显示（口径 = 整张卷子：草稿 ∪ 推导已答）。交卷后
            按钮换成「重做」，但计数留着——交卷那一刻正是用户想看「答了几题」。 */}
        {totalQuestionCount > 0 && (
          <span className="quiz-progress" data-testid="quiz-progress">
            {t('quiz.answeredProgress', {
              done: answeredCount,
              total: totalQuestionCount,
            })}
          </span>
        )}

        <button
          type="button"
          className="quiz-btn"
          data-testid="quiz-save-kb"
          disabled={!vaultId || saving}
          aria-expanded={saveOpen}
          title={!vaultId ? t('quiz.saveNoVault') : undefined}
          onClick={() => (saveOpen ? setSaveOpen(false) : openSavePanel())}
        >
          {saving ? t('quiz.saving') : t('quiz.save')}
        </button>

        {saveOpen && (
          <div className="quiz-save-panel" data-testid="quiz-save-panel">
            <div className="quiz-save-target" data-testid="quiz-save-target">
              {t('quiz.saveTarget', { vault: vaultName })}
            </div>

            <div className="quiz-scopes" role="radiogroup" aria-label={t('quiz.save')}>
              {wrongCount > 0 && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveScope === 'wrong'}
                  className="quiz-btn quiz-scope"
                  data-testid="quiz-scope-wrong"
                  onClick={() => chooseScope('wrong')}
                >
                  {t('quiz.saveScopeWrong', { count: wrongCount })}
                </button>
              )}
              <button
                type="button"
                role="radio"
                aria-checked={effectiveScope === 'all'}
                className="quiz-btn quiz-scope"
                data-testid="quiz-scope-all"
                onClick={() => chooseScope('all')}
              >
                {t('quiz.saveScopeAll', { count: candidates.length })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={effectiveScope === 'pick'}
                className="quiz-btn quiz-scope"
                data-testid="quiz-scope-pick"
                onClick={() => chooseScope('pick')}
              >
                {t('quiz.saveScopePick')}
              </button>
            </div>

            <div className="quiz-save-list" data-testid="quiz-save-list">
              {effectiveScope === 'pick' ? candidates.map(({ index, outcome }) => (
                <label key={index} className="quiz-save-row">
                  <input
                    type="checkbox"
                    className="quiz-save-check"
                    data-testid="quiz-save-pick"
                    checked={picked.has(index)}
                    onChange={() => togglePicked(index)}
                  />
                  <span className="quiz-save-index">{index + 1}</span>
                  <span className="quiz-save-stem">{previewStem(quiz.questions[index]!.stem)}</span>
                  <span className={`quiz-save-badge ${outcome}`}>
                    {outcome === 'correct' ? t('quiz.outcomeCorrect')
                      : outcome === 'wrong' ? t('quiz.outcomeWrong') : t('quiz.outcomeUngraded')}
                  </span>
                </label>
              )) : selected.map(({ index, outcome }) => (
                <div key={index} className="quiz-save-row quiz-save-row--static">
                  <span className="quiz-save-index">{index + 1}</span>
                  <span className="quiz-save-stem">{previewStem(quiz.questions[index]!.stem)}</span>
                  <span className={`quiz-save-badge ${outcome}`}>
                    {outcome === 'correct' ? t('quiz.outcomeCorrect')
                      : outcome === 'wrong' ? t('quiz.outcomeWrong') : t('quiz.outcomeUngraded')}
                  </span>
                </div>
              ))}
            </div>

            <div className="quiz-save-actions">
              <button
                type="button"
                className="quiz-btn quiz-btn-primary"
                data-testid="quiz-save-confirm"
                disabled={saving || selected.length === 0}
                onClick={handleSave}
              >
                {saving ? t('quiz.saving') : t('quiz.saveConfirm', { count: selected.length })}
              </button>
              <button
                type="button"
                className="quiz-btn"
                data-testid="quiz-save-cancel"
                onClick={() => setSaveOpen(false)}
              >
                {t('quiz.saveCancel')}
              </button>
            </div>

            {saveError && <span className="quiz-error" role="alert">{saveError}</span>}
          </div>
        )}

        {saved && (
          <div className="quiz-save-result" data-testid="quiz-save-result">
            <span className="quiz-save-result-text" title={saved.path}>
              {t('quiz.savedSummary', { count: saved.count, path: saved.path })}
            </span>
            {(saveActionsVisible || undoError) && (
              <span
                className="quiz-save-result-actions"
                // 键盘焦点落进按钮就把窗口收掉：否则读到「撤销」时按钮被计时器抽走，
                // 焦点跌回 body。
                onFocusCapture={clearSaveActionsTimer}
              >
                <button
                  type="button"
                  className="quiz-btn quiz-save-action"
                  data-testid="quiz-save-open"
                  onClick={() => { if (vaultId) openFile(vaultId, saved.path); }}
                >
                  {t('quiz.saveOpen')}
                </button>
                {revealReady && (
                  <button
                    type="button"
                    className="quiz-btn quiz-save-action"
                    data-testid="quiz-save-reveal"
                    onClick={() => { if (targetVault?.path) revealInFolder(targetVault.path, saved.path); }}
                  >
                    {t('quiz.saveReveal')}
                  </button>
                )}
                <button
                  type="button"
                  className="quiz-btn quiz-save-action"
                  data-testid="quiz-save-undo"
                  disabled={undoing}
                  onClick={handleUndo}
                >
                  {t('quiz.saveUndo')}
                </button>
              </span>
            )}
            {undoError && <span className="quiz-error" role="alert">{undoError}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
