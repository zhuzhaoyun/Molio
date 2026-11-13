/**
 * Quiz 交互块协议（```quiz 围栏 JSON）的纯函数层。
 *
 * 实现已下沉到 `@molio/contracts`（daemon 侧统计题卡数要用同一套判定口径，
 * 两处各写一份会漂移）。本文件保留为转发层，web 侧 import 路径不变。
 */

export {
  QUIZ_PROTOCOL_VERSION,
  MAX_QUIZ_RAW_CHARS,
  MAX_QUIZ_QUESTIONS,
  MAX_QUIZ_OPTIONS,
  MAX_FILL_ANSWERS,
  MAX_SUBJECT_POINTS,
  MAX_SUBJECT_POINT_CHARS,
  MAX_QUIZ_KEY_CHARS,
  MAX_QUIZ_ID_CHARS,
  isSubjectQuestion,
  quizStemOf,
  parseQuizBlock,
  normalizeFillText,
  isFillAnswerCorrect,
  gradeQuiz,
  isQuizComplete,
  canonicalQuizJson,
  computeQuizFingerprint,
  quizStorageKey,
  parseStoredQuizState,
  stripQuizForStreaming,
  countQuizCards,
} from '@molio/contracts';

export type {
  QuizQuestionType,
  QuizOption,
  QuizSource,
  QuizQuestion,
  Quiz,
  InvalidQuestion,
  QuizParseResult,
  QuizSelections,
  QuizGrade,
} from '@molio/contracts';
