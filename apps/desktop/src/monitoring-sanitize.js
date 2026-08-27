/**
 * 监控数据脱敏纯函数（不依赖 @arms/rum-electron，便于单测）。
 *
 * Molio 是知识库 + AI 对话应用，URL 里的 vaultId、堆栈里的本地路径必须脱敏后才上报。
 */

// Windows paths can appear with either separator: D:\code\foo or D:/code/foo.
// URL-form Windows paths also leak: new URL('file:///D:/code/foo').pathname = '/D:/code/foo'.
const LOCAL_PATH_RE = /([A-Z]:[\\/][^\s'"<>)]+|\/Users\/[^\s'"<>)]+|\/home\/[^\s'"<>)]+)/g;
const FILE_URL_RE = /file:\/\/[^\s'"<>)]+/g;
const VAULT_ID_RE = /\/vaults\/[a-zA-Z0-9_-]+/g;
const VAULT_QUERY_RE = /([?&])vault=[^&]+/g;
const FILE_QUERY_RE = /([?&])(file|path)=([^&]+)/g;

/**
 * 脱敏单条字符串：替换本地绝对路径与 vaultId。
 * 路径前缀（含用户名/家目录）脱敏，但保留 basename（含可选 :line:col）
 * 以便在 ARMS 后台能定位到具体文件——光有 <local-path> 占位符无法排查。
 */
export function sanitizeString(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(FILE_URL_RE, redactFileUrl)
    .replace(LOCAL_PATH_RE, redactLocalPath)
    .replace(VAULT_ID_RE, '/vaults/[vaultId]')
    .replace(VAULT_QUERY_RE, '$1vault=[vaultId]')
    .replace(FILE_QUERY_RE, '$1$2=[path]');
}

/**
 * file:// URL → <file-url>/<basename>。basename 保留以便定位页面/资源。
 * query string 不在 FILE_URL_RE 范围内（[^\s'"<>)]+ 会吃到 `?`、`&`、`=`
 * 等字符），所以可能带上 query；query 部分交给后续 FILE_QUERY_RE/VAULT_QUERY_RE 脱敏。
 */
function redactFileUrl(match) {
  const noScheme = match.slice('file://'.length);
  const lastSlash = noScheme.lastIndexOf('/');
  if (lastSlash < 0) return '<file-url>';
  const tail = noScheme.slice(lastSlash + 1);
  if (!tail) return '<file-url>';
  return `<file-url>/${tail}`;
}

/**
 * 本地绝对路径 → <local-path>(\|/)<basename>[:line:col]。保留 basename
 * 以便堆栈和 view name 里能看出是哪个文件。分隔符沿用原路径的分隔符，
 * 避免给 reviewer 制造 Windows/macOS 混淆。
 */
function redactLocalPath(match) {
  const lastSlash = match.lastIndexOf('/');
  const lastBack = match.lastIndexOf('\\');
  const last = Math.max(lastSlash, lastBack);
  if (last <= 0) return '<local-path>';
  const sep = match[last];
  const tail = match.slice(last + 1);
  if (!tail) return '<local-path>';
  return `<local-path>${sep}${tail}`;
}

/**
 * 递归处理 bundle 内所有字符串字段。
 * bundle 可能是 object/array/string/number 等。仅处理字符串，其他原样返回。
 */
export function sanitizeBundle(bundle) {
  if (bundle === null || bundle === undefined) return bundle;
  if (typeof bundle === 'string') return sanitizeString(bundle);
  if (Array.isArray(bundle)) return bundle.map(sanitizeBundle);
  if (typeof bundle === 'object') {
    const out = {};
    for (const key of Object.keys(bundle)) {
      out[key] = sanitizeBundle(bundle[key]);
    }
    return out;
  }
  return bundle;
}

/**
 * userId 格式契约：26 字符 Crockford base32（大写），与云端 apps/cloud/src/crypto.ts
 * 的 ulid() 输出严格一致（字母表无 I/L/O/U）。校验是纵深防御——未来任何来源的
 * 奇怪字符串（邮箱、SQL、构造错误）都不会流入监控归因字段。
 */
const USER_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 把 Molio userId 注入 bundle 的 `user.id`（用户模块 M4，设计 §十一）。
 *
 * ARMS SDK（0.0.5–0.0.7）没有 setUser API：reporter 组 bundle 时 `user.id`
 * 只取内部 session 生成的匿名设备 UID，`config.user.id` 被显式跳过。
 * beforeReport 钩子是唯一干净注入点。
 *
 * - userId 是合法 ULID 时：浅拷贝 bundle，置 `user.id = userId`
 *   （保留 bundle.user 上其他字段；无 user 字段则新建 `{ id }`）。
 * - userId 为空/非字符串/非法格式（未登录或格式违约）时：原样返回 bundle，
 *   保留 SDK 匿名 uid 兜底。**绝不含邮箱**——监控归因不带 PII。
 */
export function injectUserId(bundle, userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) return bundle;
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return bundle;
  const existing = bundle.user;
  const user =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing, id: userId }
      : { id: userId };
  return { ...bundle, user };
}

/**
 * URL → view name：脱敏 vaultId 和文件路径参数。
 * pathname 与 search 各经一次 sanitizeString——脱敏规则单点收口在 sanitizeString，
 * 不在此处二次套用正则（旧实现拼接后又重跑 VAULT_ID_RE/LOCAL_PATH_RE，纯冗余）。
 */
export function sanitizeViewName(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const u = new URL(url, 'http://localhost');
    return sanitizeString(u.pathname || '/') + sanitizeString(u.search || '');
  } catch {
    return sanitizeString(url);
  }
}

/**
 * 过滤 ARMS SDK 的「自报噪音」异常事件（在 beforeReport 里先于脱敏执行）。
 *
 * 背景：@arms/rum-electron 0.0.5 的 electron-reporter.request() 有 promise 泄漏——
 * 上报请求失败（undici 网络层 TypeError: fetch failed）时，`U.finally(...)` 产生的
 * 镜像 promise 无人处理 → 进程级 unhandledRejection → SDK 自己的 exception
 * collector 又把它当应用异常上报，形成「监控上报失败 → 上报这个失败」的自报噪音。
 * 上游 0.0.7 已修复（catch 吞错入离线队列，不再 rethrow），本地 patch 已随升级撤掉；
 * 本函数保留为兜底，防止 SDK 未来版本同类泄漏再次污染异常统计
 * （回归防线见 test/monitoring/arms-sdk-fetch-leak.test.js）。
 *
 * 不会误伤真实错误：
 * - 桌面主进程所有 fetch 调用点（daemon-metrics 健康轮询、/api/shutdown）都有 catch；
 * - renderer(Chromium) 的 fetch 失败消息是 "Failed to fetch"（大写 F、不同消息）；
 * - daemon 子进程没有 ARMS SDK，它的 fetch 失败不会进入这条上报链路。
 *
 * @param {any} bundle SDK 传入的上报 bundle（{ app, user, session, events, ... }）
 * @returns {any} 过滤后的 bundle；events 全是噪音时返回 null（SDK 收到 falsy 会跳过本次上报）
 */
export function dropFetchFailedNoise(bundle) {
  if (bundle === null || bundle === undefined || typeof bundle !== 'object') return bundle;
  const events = bundle.events;
  if (!Array.isArray(events)) return bundle;
  const kept = events.filter((e) => !(
    e !== null && typeof e === 'object' &&
    e.event_type === 'exception' &&
    e.name === 'TypeError' &&
    e.message === 'fetch failed'
  ));
  if (kept.length === 0) return null;
  if (kept.length === events.length) return bundle;
  return { ...bundle, events: kept };
}

/**
 * URL → resource name：取 pathname，路径段中的 vaultId/本地路径脱敏。
 * 同 sanitizeViewName：规则单点走 sanitizeString，不重复实现。
 */
export function sanitizeResourceName(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const u = new URL(url, 'http://localhost');
    return sanitizeString(u.pathname || '/');
  } catch {
    return sanitizeString(url);
  }
}
