/**
 * 会话级「做过题」痕迹统计——历史列表徽标的数据来源。
 *
 * 两个口径都刻意与聊天渲染器同源：
 * - **卡数**：消息里渲染出来的题卡数。走 `@molio/contracts` 的 countQuizCards
 *   （= splitContent + parseQuizBlock）。不用 LIKE/子串近似：嵌套围栏、一条
 *   消息多张卡、JSON 畸形这几种情形下近似判定会与渲染器分叉。
 * - **对数**：答对的题数。按 (fingerprint, question_id) 取最近一次作答去重——
 *   重做（handleRedo 清空选择后重新提交）会再写一行，直接 SUM 会把得分翻倍。
 *
 * 卡数的候选集用 FTS 收窄（trigram 索引，命中即含 ```quiz），再逐条精确判定：
 * 真实库实测 27 条含围栏消息里 27 条都是真题卡，但围栏**出现**不等于**渲染出
 * 题卡**（闭合 + 语言名恰为 quiz + JSON 合法），收窄只是省 IO。
 *
 * 范围：**仅桌面端会话**。渠道会话（微信/飞书/企业微信）里模型若吐出 quiz 围栏，
 * 渠道侧是当纯文本发出去的（那边不渲染题卡、也无处作答），把那种会话标成
 * 「做过题」是假的。真实库实测 27 条含围栏消息全部来自 desktop 渠道。
 */

import { countQuizCards } from '@molio/contracts';
import type { SqliteDb } from './db.js';

/** 一个会话的做题痕迹。 */
export interface QuizTrace {
  /** 渲染出来的题卡数。 */
  cardCount: number;
  /** 答对的题数（按题目去重后取最近一次作答）。 */
  correctCount: number;
}

/**
 * 批量统计会话的做题痕迹。
 *
 * 只查给定会话；会话列表每次最多几十条，代价可接受。**每个传入的会话都有一项**
 * （没做过题的两个数都是 0），调用方不必处理缺省。
 */
export function quizTracesByConversation(
  db: SqliteDb,
  conversationIds: string[],
): Map<string, QuizTrace> {
  const traces = new Map<string, QuizTrace>();
  if (conversationIds.length === 0) return traces;

  // 只统计桌面端会话（见文件头「范围」）。渠道会话的题卡是纯文本，不算做过题。
  const desktopIds = (
    db
      .prepare(
        `SELECT id FROM conversations
          WHERE id IN (${conversationIds.map(() => '?').join(',')})
            AND channel_type = 'desktop'`,
      )
      .all(...conversationIds) as Array<{ id: string }>
  ).map((row) => row.id);

  // 没做过题的会话也要有一项，调用方不必处理缺省。
  for (const id of conversationIds) {
    traces.set(id, { cardCount: 0, correctCount: 0 });
  }
  if (desktopIds.length === 0) return traces;

  const placeholders = desktopIds.map(() => '?').join(',');

  // 卡数：FTS 收窄候选 → 精确判定 → 按会话累加。
  // 只算 assistant 消息——用户消息永远不渲染题卡（UserMessage 不走题卡渲染）。
  const candidates = db
    .prepare(
      `SELECT m.conversation_id AS conversation_id, f.content AS content
         FROM messages_fts f
         JOIN messages m ON m.id = f.message_id
        WHERE f.messages_fts MATCH ?
          AND m.role = 'assistant'
          AND m.conversation_id IN (${placeholders})`,
    )
    .all('"```quiz"', ...desktopIds) as Array<{ conversation_id: string; content: string }>;

  for (const row of candidates) {
    const cards = countQuizCards(row.content);
    if (cards === 0) continue;
    const current = traces.get(row.conversation_id);
    if (!current) continue;
    current.cardCount += cards;
  }

  // 对数：按 (fingerprint, question_id) 取最近一次作答，避免重做把得分翻倍。
  const correctRows = db
    .prepare(
      `SELECT conversation_id, SUM(correct) AS n
         FROM (
           SELECT conversation_id, correct,
                  ROW_NUMBER() OVER (
                    PARTITION BY conversation_id, quiz_fingerprint, question_id
                    ORDER BY answered_at DESC, id DESC
                  ) AS rn
             FROM quiz_attempts
            WHERE conversation_id IN (${placeholders})
         )
        WHERE rn = 1
        GROUP BY conversation_id`,
    )
    .all(...desktopIds) as Array<{ conversation_id: string; n: number }>;

  for (const row of correctRows) {
    const current = traces.get(row.conversation_id);
    if (!current) continue;
    current.correctCount = Number(row.n);
  }

  // 没做过题的会话也要有一项，调用方不必处理缺省。
  for (const id of conversationIds) {
    if (!traces.has(id)) traces.set(id, { cardCount: 0, correctCount: 0 });
  }

  return traces;
}
