/**
 * 文档出图头卡：标题 + 元信息 + 标签。
 *
 * 只有这一个模块知道头卡长什么样。meta 字符串由调用方（KbMainContent）
 * 本地化拼好传进来——这个文件不碰 i18n，保持可在 node:test 直跑。
 * 头卡 DOM 被插成导出容器的第一个子块，与正文同一套测量与分页：
 * 「头卡量了但分页没算」这类二阶 bug 从结构上不可能发生。
 */

export interface ExportHeaderData {
  title: string;
  /** 已本地化的元信息行，如 `库名 · 2026年10月20日 · 1234 字 · 约 3 分钟`。 */
  meta: string;
  tags?: string[];
}

export const HEADER_CLASS = 'molio-export-head';
export const MAX_HEADER_TAGS = 5;

const CJK = /[一-鿿぀-ヿ가-힯]/g;

/** CJK 字符逐字计，拉丁文按词计——中英混排文档的「字数」取两者之和。 */
export function countDocWords(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (
    text.replace(CJK, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []
  ).length;
  return cjk + latin;
}

/** 中文阅读速度约 400 字/分钟；再短的文档也按 1 分钟计。 */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 400));
}

/** 跟随 locale 的长日期，如 `2026年10月20日` / `October 20, 2026`。 */
export function formatHeaderDate(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function buildHeaderEl(data: ExportHeaderData): HTMLElement {
  const root = document.createElement('div');
  root.className = HEADER_CLASS;

  const title = document.createElement('div');
  title.className = `${HEADER_CLASS}__title`;
  title.textContent = data.title;
  root.appendChild(title);

  const meta = document.createElement('div');
  meta.className = `${HEADER_CLASS}__meta`;
  meta.textContent = data.meta;
  root.appendChild(meta);

  const tags = data.tags ?? [];
  const shown = tags.slice(0, MAX_HEADER_TAGS);
  if (shown.length > 0) {
    const tagsEl = document.createElement('div');
    tagsEl.className = `${HEADER_CLASS}__tags`;
    for (const tag of shown) {
      const el = document.createElement('span');
      el.textContent = tag;
      tagsEl.appendChild(el);
    }
    if (tags.length > shown.length) {
      const more = document.createElement('span');
      more.className = `${HEADER_CLASS}__more`;
      more.textContent = `+${tags.length - shown.length}`;
      tagsEl.appendChild(more);
    }
    root.appendChild(tagsEl);
  }
  return root;
}
