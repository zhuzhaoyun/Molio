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
 */
export function sanitizeString(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(FILE_URL_RE, '<file-url>')
    .replace(LOCAL_PATH_RE, '<local-path>')
    .replace(VAULT_ID_RE, '/vaults/[vaultId]')
    .replace(VAULT_QUERY_RE, '$1vault=[vaultId]')
    .replace(FILE_QUERY_RE, '$1$2=[path]');
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
      .replace(LOCAL_PATH_RE, '<local-path>');
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
      .replace(LOCAL_PATH_RE, '<local-path>');
  } catch {
    return sanitizeString(url);
  }
}
