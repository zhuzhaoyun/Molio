import { isSubjectQuestion, type Quiz, type QuizGrade, type QuizSelections } from './quiz.ts';
import { gradingMapKey, type QuizGrading } from './quizAnswer.ts';
import type { QuizFileQuestion, QuizQuestionOutcome } from './quizFile.ts';

export type QuizSaveScope = 'wrong' | 'all' | 'pick';

export interface QuizSaveContext {
  /** 是否已交卷（客观题没交卷就没有判定）。 */
  submitted: boolean;
  /** 交卷后的本地判分；未交卷传 []。 */
  grades: QuizGrade[];
  /** 解答题批改回写（键 = `指纹:题号`）。 */
  subjectGradings: Map<string, QuizGrading>;
  fingerprintKey: string;
}

export interface QuizSaveCandidate {
  /** questions 下标（0 基）。 */
  index: number;
  outcome: QuizQuestionOutcome;
}

/**
 * 逐题三态判定。
 *
 * 大题只认批改分数：`gradeQuiz` 对 subject 一律返回 `correct: false`，
 * 拿它判错题会把每道大题都算错。
 */
export function classifyQuestions(quiz: Quiz, ctx: QuizSaveContext): QuizSaveCandidate[] {
  const gradeMap = new Map(ctx.grades.map((grade) => [grade.questionId, grade]));
  return quiz.questions.map((question, index) => {
    if (isSubjectQuestion(question)) {
      const grading = ctx.subjectGradings.get(gradingMapKey(ctx.fingerprintKey, index + 1));
      if (!grading) return { index, outcome: 'ungraded' };
      return { index, outcome: grading.score < grading.total ? 'wrong' : 'correct' };
    }
    if (!ctx.submitted) return { index, outcome: 'ungraded' };
    const grade = gradeMap.get(question.id);
    if (!grade) return { index, outcome: 'ungraded' };
    return { index, outcome: grade.correct ? 'correct' : 'wrong' };
  });
}

/** 有错题就默认只存错题；没错题（或没作答）时默认全部。 */
export function pickDefaultScope(candidates: QuizSaveCandidate[]): 'wrong' | 'all' {
  return candidates.some((candidate) => candidate.outcome === 'wrong') ? 'wrong' : 'all';
}

export function selectForSave(
  candidates: QuizSaveCandidate[],
  scope: QuizSaveScope,
  pickedIndices: ReadonlySet<number>,
): QuizSaveCandidate[] {
  if (scope === 'wrong') return candidates.filter((candidate) => candidate.outcome === 'wrong');
  if (scope === 'pick') return candidates.filter((candidate) => pickedIndices.has(candidate.index));
  return candidates;
}

/**
 * 把选中的题装配成文件条目：题号 = 下标 + 1（与 gradingMapKey 同口径），
 * 「你的答案」按题型从选择/作答正文取。
 */
export function buildQuizFileQuestions(
  quiz: Quiz,
  selected: QuizSaveCandidate[],
  ctx: QuizSaveContext,
  selections: QuizSelections,
  subjectAnswers: Map<string, string>,
): QuizFileQuestion[] {
  return selected.map(({ index, outcome }) => {
    const question = quiz.questions[index]!;
    const number = index + 1;
    const key = gradingMapKey(ctx.fingerprintKey, number);

    let given: string | null;
    if (isSubjectQuestion(question)) {
      given = subjectAnswers.get(key) ?? null;
    } else if (question.type === 'fill') {
      given = selections[question.id]?.[0] ?? '';
    } else {
      given = [...(selections[question.id] ?? [])].sort().join('、');
    }

    const grading = isSubjectQuestion(question) ? ctx.subjectGradings.get(key) : undefined;
    return {
      number,
      question,
      outcome,
      given,
      ...(grading ? { grading: { score: grading.score, total: grading.total } } : {}),
    };
  });
}
