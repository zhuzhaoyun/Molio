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
 * 把 Molio userId 注入 bundle 的 `user.id`（用户模块 M4，设计 §十一）。
 *
 * ARMS SDK（0.0.5–0.0.7）没有 setUser API：reporter 组 bundle 时 `user.id`
 * 只取内部 session 生成的匿名设备 UID，`config.user.id` 被显式跳过。
 * beforeReport 钩子是唯一干净注入点。
 *
 * - userId 为真（非空字符串）时：浅拷贝 bundle，置 `user.id = userId`
 *   （保留 bundle.user 上其他字段；无 user 字段则新建 `{ id }`）。
 * - userId 为空/非字符串（未登录）时：原样返回 bundle，保留 SDK 匿名 uid 兜底。
 * - userId 只允许 ULID（daemon 侧 user.id），**绝不含邮箱**——监控归因不带 PII。
 */
export function injectUserId(bundle, userId) {
  if (typeof userId !== 'string' || userId === '') return bundle;
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
 */
export function sanitizeViewName(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const u = new URL(url, 'http://localhost');
    const pathname = u.pathname || '/';
    const search = sanitizeString(u.search || '');
    return `${pathname}${search}`
      .replace(VAULT_ID_RE, '/vaults/[vaultId]')
      .replace(LOCAL_PATH_RE, redactLocalPath);
  } catch {
    return sanitizeString(url);
  }
}

/**
 * URL → resource name：取 pathname，路径段中的 vaultId 脱敏。
 */
export function sanitizeResourceName(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const u = new URL(url, 'http://localhost');
    return (u.pathname || '/')
      .replace(VAULT_ID_RE, '/vaults/[vaultId]')
      .replace(LOCAL_PATH_RE, redactLocalPath);
  } catch {
    return sanitizeString(url);
  }
}
