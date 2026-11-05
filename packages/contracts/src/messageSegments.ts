/**
 * Message content segmentation — the shared fence scanner.
 *
 * Lives in contracts (not apps/web) because the daemon must count quiz cards
 * with exactly the rule the chat renderer uses: a card is a *closed* fence
 * whose language name is exactly `quiz` (case-sensitive) and whose body
 * parses as a quiz card. Re-implementing that rule in SQL drifted on nested
 * fences, multi-card messages and malformed JSON — so the scanner and the
 * protocol parser are shared instead.
 */

export type Segment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'quiz'; raw: string; complete: boolean }
  | { type: 'sandbox'; raw: string; complete: boolean };

/** 一段围栏及其在原文中的位置。 */
interface Fence {
  /** 语言名（围栏后紧跟的标识）；无语言名时是空串。 */
  lang: string;
  /** 围栏正文（开围栏之后、闭围栏之前）。未闭合时是开围栏之后的全部内容。 */
  body: string;
  /** 是否闭合。 */
  complete: boolean;
  /** 开围栏在原文中的起始位置。 */
  openStart: number;
  /** 围栏正文在原文中的起始位置。 */
  bodyStart: number;
  /** 围栏正文在原文中的结束位置（不含）。 */
  bodyEnd: number;
  /** 整段围栏（含开闭标记）在原文中的结束位置（不含）。未闭合时是内容长度。 */
  blockEnd: number;
}

/**
 * 扫描内容里的所有围栏。
 *
 * 与渲染器同一套语义：开围栏由 `` ```([\w][\w-]*)?\n? `` 匹配（语言名必须以
 * 词字符开头，故「```- 内容」这种首行以 - 开头的裸围栏不算语言名），闭围栏取正文
 * 之后**第一个** ``` ——不要求独占一行。扫到未闭合围栏即停（后面不再有围栏）。
 */
function scanFences(content: string): Fence[] {
  const fences: Fence[] = [];
  // 语言名允许连字符（`rule-sandbox`、`objective-c`）—— \w* 会把 `rule-sandbox`
  // 截成 `rule`，那样交互块永远识别不出来。但必须以 \w 开头：否则「```- 内容」
  // 这种首行以 - 开头的裸围栏会把 `-` 吃成语言名，丢掉首字符。
  const fence = /```([\w][\w-]*)?\n?/g;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(content)) !== null) {
    const lang = match[1] || '';
    const openStart = match.index;
    const bodyStart = openStart + match[0].length;
    const closeIdx = content.indexOf('```', bodyStart);
    if (closeIdx === -1) {
      // Unclosed (streaming): the tail is the block body.
      fences.push({
        lang,
        body: content.slice(bodyStart),
        complete: false,
        openStart,
        bodyStart,
        bodyEnd: content.length,
        blockEnd: content.length,
      });
      return fences;
    }
    fences.push({
      lang,
      body: content.slice(bodyStart, closeIdx),
      complete: true,
      openStart,
      bodyStart,
      bodyEnd: closeIdx,
      blockEnd: closeIdx + 3,
    });
    fence.lastIndex = closeIdx + 3;
  }
  return fences;
}

/**
 * Split message content into text, fenced-code and interactive-block segments.
 * Text segments are rendered with renderMarkdown (preserving wiki-link/list/etc.
 * logic); code segments are rendered with <CodeBlock>; quiz and rule-sandbox
 * segments are rendered by their own components (interactive-block registry).
 *
 * Handles unclosed fences (streaming mid-block) by marking the tail segment
 * incomplete. Interactive-block consumers show a "generating" placeholder
 * instead of parsing.
 */
export function splitContent(content: string): Segment[] {
  if (!content) return [];
  const segments: Segment[] = [];
  let cursor = 0;

  for (const fence of scanFences(content)) {
    if (fence.openStart > cursor) {
      segments.push({ type: 'text', content: content.slice(cursor, fence.openStart) });
    }
    if (fence.lang === 'quiz') {
      segments.push({ type: 'quiz', raw: fence.body, complete: fence.complete });
    } else if (fence.lang === 'rule-sandbox') {
      segments.push({ type: 'sandbox', raw: fence.body, complete: fence.complete });
    } else {
      segments.push({ type: 'code', lang: fence.lang, code: fence.body });
    }
    cursor = fence.blockEnd;
    if (!fence.complete) return segments; // unclosed tail: nothing after it
  }

  if (cursor < content.length) {
    segments.push({ type: 'text', content: content.slice(cursor) });
  }
  return segments;
}

/**
 * 去掉内容里的题卡围栏（连同正文），其余原样保留。
 *
 * 历史列表的摘要在「最后一条消息就是一张题卡」时会直接显示裸 JSON——这里把题卡
 * 摘掉，只留给人看的文字。与 splitContent 同一套围栏语义。
 */
export function stripQuizFences(content: string): string {
  if (!content) return content;
  let output = '';
  let cursor = 0;
  for (const fence of scanFences(content)) {
    if (fence.lang !== 'quiz') continue;
    output += content.slice(cursor, fence.openStart);
    cursor = fence.blockEnd;
  }
  return output + content.slice(cursor);
}
