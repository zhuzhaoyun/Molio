/**
 * Daemon-side 桌面端加密客户端 — 调用 Electron 主进程 safeStorage 加密服务。
 *
 * daemon 以 `ELECTRON_RUN_AS_NODE=1` 运行（桌面模式），拿不到 Electron API，
 * 主进程因此起一个本机 HTTP server 暴露 encrypt/decrypt（apps/desktop/src/crypto-server.js），
 * 端口在 spawn daemon 时经 `MOLIO_DESKTOP_CRYPTO_PORT` env 注入。先例与模式同
 * `MOLIO_DESKTOP_FETCH_PORT`（core/feishu/wiki-fetcher.ts）。
 *
 * 设计要点：
 * - env 缺失（dev / Docker / 独立 daemon）→ 未配置，调用方走明文基线（设计 §八 D3）。
 * - **从不抛错**：任何失败（未配置 / 连接失败 / 超时 / 503 / 坏响应）返回 null，
 *   token-store 据此降级（读 → 视为未登录不删文件；写 → 跳过落盘保内存）。
 * - 2s 超时：加解密是本机同步 DPAPI/Keychain 操作，毫秒级；超时只可能在
 *   主进程卡死时出现，快失败优于阻塞登录/刷新链路。
 * - 共享密钥（可选）：主进程 spawn 时另注入 `MOLIO_DESKTOP_CRYPTO_TOKEN`，
 *   daemon 每次调用带 `Authorization: Bearer <token>`，主进程校验（防本机其他
 *   进程冒用加密服务）。env 缺失时保持旧行为（不带头），两端同步升级。
 */

/** 加密服务端口 env（Electron 主进程 spawn daemon 时注入）。 */
export const CRYPTO_PORT_ENV = 'MOLIO_DESKTOP_CRYPTO_PORT';

/** 加密 RPC 共享密钥 env（主进程注入；缺失 → 不启用头部校验，向后兼容）。 */
export const CRYPTO_TOKEN_ENV = 'MOLIO_DESKTOP_CRYPTO_TOKEN';

const CRYPTO_TIMEOUT_MS = 2_000;

/** 失败告警限频间隔：crypto 服务暂挂期间每次 refresh 都会触发加密尝试，防日志风暴。 */
const WARN_MIN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt >= WARN_MIN_INTERVAL_MS) {
    lastWarnAt = now;
    console.warn(message);
  }
}

/** env 懒读（测试可在运行时改 env）。非法值按未配置处理。 */
export function resolveCryptoPort(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[CRYPTO_PORT_ENV];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** 共享密钥懒读；空/纯空白按未配置。 */
export function resolveCryptoToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[CRYPTO_TOKEN_ENV];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

async function call(
  path: '/encrypt' | '/decrypt',
  body: Record<string, unknown>,
): Promise<string | null> {
  const port = resolveCryptoPort();
  if (!port) return null;
  try {
    const token = resolveCryptoToken();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CRYPTO_TIMEOUT_MS),
      // 本机 RPC 永不重定向：跟随重定向可能把明文 token 发到非预期地址
      redirect: 'error',
    });
    if (!res.ok) {
      warnThrottled(`auth: desktop crypto ${path} 返回 ${res.status}（token 保持内存/文件现状）`);
      return null;
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      warnThrottled(`auth: desktop crypto ${path} 响应体非对象，按失败处理`);
      return null;
    }
    const rec = data as Record<string, unknown>;
    const value = path === '/encrypt' ? rec['data'] : rec['plaintext'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    warnThrottled(`auth: desktop crypto ${path} 失败（服务暂挂/超时/拒连，按未加密降级路径走）`);
    return null;
  }
}

/** 加密明文 → base64 密文；失败返回 null。 */
export function encryptWithDesktop(plaintext: string): Promise<string | null> {
  return call('/encrypt', { plaintext });
}

/** 解密 base64 密文 → 明文；失败返回 null。 */
export function decryptWithDesktop(data: string): Promise<string | null> {
  return call('/decrypt', { data });
}

/** 加密服务是否已配置（env 存在且合法）。 */
export function isDesktopCryptoConfigured(): boolean {
  return resolveCryptoPort() !== null;
}
