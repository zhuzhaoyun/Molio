/**
 * Daemon-side Feishu wiki/docx 正文抓取客户端。
 *
 * 调用桌面端 wiki-fetcher 暴露的本机 HTTP server（POST http://127.0.0.1:<port>/fetch-wiki）
 * 把 wiki/docx 链接的正文渲染后的 Markdown 抓回来。FeishuService 在 dispatch 之前调
 * `materializeWikiLinks`，把裸 URL 替换成「## 来源\n\n<markdown>」。
 *
 * 设计要点：
 * - port 来自 `MOLIO_DESKTOP_FETCH_PORT` env，Electron 主进程在 spawn daemon 时注入。
 *   dev 模式（pnpm dev:daemon）下没有这个 env → 函数返回 `fetcher_unavailable`，
 *   FeishuService 保留裸 URL + 注入「dev 模式未启用桌面端抓取」提示，不回退到 agent
 *   curl（实测 agent curl 在 feishu wiki 上从来不通，CDN edge 直接 404）。
 * - 抓取串行（多 URL 用 Promise.all 但每个有独立 30s 超时）。
 * - 不区分错误类型，任何失败都返回 `{ markdown: null, reason }`，调用方决定如何降级。
 */

/** 飞书正文类 URL — wiki / docx 走 BrowserView 抓取；sheets/base/slides 等不抓（DOM 是 canvas，
 *  正文非 HTML）。这些路径调 materializeWikiLinks 时会被识别但不调 fetcher，直接保留原 URL +
 *  提示用户导出。 */
const FETCHABLE_PATH_RE = /\/(?:wiki|docx)\/[A-Za-z0-9]+/i;
/** 所有飞书正文类 URL（用于检测/提示，但 sheets/base/slides 不调 fetcher）。 */
const FEISHU_DOC_URL_RE =
  /https?:\/\/[\w-]+\.(?:feishu\.cn|larksuite\.com)\/(?:wiki|docx|sheets|base|slides|mindnotes|wiki\/docs)\/[^\s。，,；;）)》"'，！？]+/gi;

export interface WikiFetchResult {
  markdown: string | null;
  title?: string;
  reason?: string;
  /** 抓取失败时可能是 'wiki' / 'docx' / 'sheets' / 'base' / 'slides' / 'unknown'。 */
  docType?: string;
  cached?: boolean;
  /** 透传桌面端 fetcher 的具体错误消息（仅在 reason='fetch_error' 等时填充）。 */
  error?: string;
}

/**
 * 从文本中提取飞书正文类 URL（wiki/docx/sheets/base/slides/mindnotes）。
 * 不抓取 fetchable 类型（sheets/base/slides）由调用方单独处理（提示用户导出）。
 */
export function extractFeishuDocUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(FEISHU_DOC_URL_RE);
  if (!matches) return [];
  // Dedup, preserve first-seen order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of matches) {
    // Strip (1) anything from a closing paren/backslash onward, and (2) trailing
    // ASCII sentence punctuation. The URL regex's char class only excludes
    // whitespace + CJK punctuation, so a link pasted at the end of a sentence
    // (e.g. ".../wikcnXXX?" or ".../wikcnXXX.") drags the trailing ?/. in —
    // which can make Feishu serve a blank page → render_timeout with bodyLen=0.
    // Feishu doc IDs are alphanumeric, so stripping these trailing chars is safe.
    const trimmed = url.replace(/[)\\].*$/, '').replace(/[?&=.,;:!]+$/, '');
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** 拆出 URL 的 docType 段（wiki / docx / sheets / base / slides / mindnotes）。 */
export function urlDocType(url: string): string {
  const m = url.match(/\/(wiki|docx|sheets|base|slides|mindnotes)(?:\/|$)/i);
  return m && m[1] ? m[1].toLowerCase() : 'unknown';
}

/** 取 URL 的飞书租户域名（如 geekbang.feishu.cn）；非飞书/Lark 域名返回 null。 */
export function tenantHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** 该 URL 是否能走 BrowserView 抓取（即渲染容器是 HTML 正文，非 canvas）。 */
export function isFetchable(url: string): boolean {
  return FETCHABLE_PATH_RE.test(url);
}

/**
 * 调桌面端 fetcher 抓一个 URL 的正文 Markdown。
 * 内部不抛错 — 失败一律返回 `{ markdown: null, reason }`，让调用方降级。
 */
export async function fetchWikiContent(
  url: string,
  opts: { port?: number; signal?: AbortSignal } = {},
): Promise<WikiFetchResult> {
  const port = opts.port;
  if (!port) return { markdown: null, reason: 'fetcher_unavailable', docType: urlDocType(url) };
  if (!isFetchable(url)) {
    return { markdown: null, reason: 'doc_type_not_fetchable', docType: urlDocType(url) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timeout);
      return { markdown: null, reason: 'aborted', docType: urlDocType(url) };
    }
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/fetch-wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { markdown: null, reason: `http_${res.status}`, docType: urlDocType(url) };
    }
    const data = (await res.json()) as WikiFetchResult;
    return { ...data, docType: urlDocType(url) };
  } catch (err) {
    if (controller.signal.aborted && (!opts.signal || !opts.signal.aborted)) {
      return { markdown: null, reason: 'timeout', docType: urlDocType(url) };
    }
    if (opts.signal?.aborted) {
      return { markdown: null, reason: 'aborted', docType: urlDocType(url) };
    }
    return {
      markdown: null,
      reason: 'fetch_error',
      error: err instanceof Error ? err.message : String(err),
      docType: urlDocType(url),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 给一段文本里的每个飞书正文 URL 抓正文，把 Markdown 注入回原 URL 位置。
 *
 * 抓取成功 → `## 来源: <url>\n\n<markdown>` 替换裸 URL。
 * 失败（port 缺失、超时、登录墙、extract_empty 等） → 保留 URL + 注入对应提示。
 *
 * 抓取是并行（多 URL Promise.all），但每个 URL 有独立 35s 超时。
 */
export async function materializeWikiLinks(
  rawUserText: string,
  opts: { port?: number; signal?: AbortSignal } = {},
): Promise<string> {
  if (!rawUserText) return rawUserText;
  const urls = extractFeishuDocUrls(rawUserText);
  if (urls.length === 0) return rawUserText;

  const results = await Promise.all(
    urls.map((url) => fetchWikiContent(url, opts)),
  );

  let out = rawUserText;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;
    const result = results[i];
    if (!result) continue;
    out = out.replace(url, buildReplacement(url, result));
  }
  return out;
}

function buildReplacement(url: string, result: WikiFetchResult): string {
  const docType = result.docType || urlDocType(url);

  // 非 fetchable docType（sheets/base/slides/mindnotes）→ 提示导出。
  if (result.reason === 'doc_type_not_fetchable' || !isFetchable(url)) {
    return `${url}\n\n[注: ${docType} 类型文档暂不支持自动抓取，请在飞书中导出为 .xlsx 或 .md 后发我]`;
  }

  // dev 模式 / fetcher 未启动 → 提示用户用桌面端。
  if (result.reason === 'fetcher_unavailable') {
    return `${url}\n\n[注: 当前 dev 模式未启用桌面端 BrowserView 抓取，agent 无法直接读到飞书 ${docType} 正文。请用 pnpm dev:desktop 测试此场景。]`;
  }

  // 登录墙 → 这是私有文档，需要对应租户的浏览器登录态。明确引导走「登录飞书账号」，
  // 并叮嘱 agent 不要自己去 curl / 调开放 API（飞书文档是 SPA，curl 只会拿到登录页；
  // 应用 token 走 API 又需要额外的 wiki 权限，都不是设计内的抓取路径）。
  if (result.reason === 'login_required') {
    const host = tenantHost(url);
    const where = host ? `（租户 ${host}）` : '';
    return `${url}\n\n[注: 该飞书文档是私有文档，需要登录对应租户${where}的飞书账号才能读取。Molio 桌面端在检测到登录墙时会尝试自动弹出该租户的登录窗口；若未弹出，请在桌面端「设置 → 飞书渠道」点击「登录飞书账号」完成登录，然后让用户重新发送本链接。重要: 请勿用 curl/WebFetch 抓取（飞书文档是 SPA，只会返回登录页），也不要用应用 token 调开放 API（需要额外的 wiki 权限且非本应用设计路径）——正文抓取由 Molio 桌面端的浏览器登录态完成。]`;
  }

  // 渲染超时 / 抓取为空 / 其他错误 → 保留 URL + 提示。必须明确禁止 agent 自行
  // curl / 调开放 API 兜底——否则它一遇到非 login_required 的失败就会去调 API，
  // 拿到跨租户错误码 99991672 后误判成「权限未开通/未发布」，把用户带偏。
  if (!result.markdown) {
    const reason = result.reason || 'unknown';
    return `${url}\n\n[注: 飞书 ${docType} 正文抓取失败 (${reason})。重要: 请勿用 curl/WebFetch 或开放 API 重试——飞书文档是 SPA，curl 只会拿到空壳/登录页；应用 token 跨租户受限，报 99991672 等错误码是「跨租户拒绝」而非「权限未开通/未发布」，这些都是设计外路径。正文抓取只由 Molio 桌面端的浏览器登录态完成。请提示用户在桌面端确认飞书登录态、并把链接(不要带句尾标点)重新发给本机器人，或直接打开链接查看。]`;
  }

  // 成功 → 注入 Markdown。
  const title = result.title ? `# ${result.title}\n\n` : '';
  return `${title}## 来源: ${url}\n\n${result.markdown}`;
}
