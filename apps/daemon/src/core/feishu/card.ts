/**
 * Feishu interactive card (JSON 2.0) builder.
 *
 * Agent replies are Markdown, but `msg_type: 'text'` messages render none of
 * it — users see raw `#` / `**` / ``` symbols. Wrapping the text in a card
 * with a `markdown` body element makes Feishu render headings, lists, code
 * blocks, links and images (CommonMark 0.31 + GFM subset; no HTML; tables
 * paginate at 5 rows).
 * See https://open.feishu.cn/document/feishu-cards/card-json-v2-breaking-changes-release-notes
 */

/** Card JSON 2.0 with a single markdown body element. `elements` is typed as
 * a one-element tuple: we always emit exactly one element, and the tuple lets
 * `elements[0]` stay non-optional under noUncheckedIndexedAccess. */
export interface FeishuCard {
  schema: '2.0';
  body: {
    elements: [{ tag: 'markdown'; content: string }];
  };
}

/**
 * Wrap Markdown text in a minimal JSON 2.0 card. Deliberately no header —
 * placeholder texts like "Molio 正在处理..." share this send path, and a
 * titled header on every message would be noise.
 *
 * Card request bodies cap at 30KB (Feishu error 300300); callers chunk the
 * text before wrapping (see `TEXT_CHUNK_LIMIT` in service.ts).
 */
export function buildMarkdownCard(markdown: string): FeishuCard {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  };
}
