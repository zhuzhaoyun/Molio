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
 */

/** 加密服务端口 env（Electron 主进程 spawn daemon 时注入）。 */
export const CRYPTO_PORT_ENV = 'MOLIO_DESKTOP_CRYPTO_PORT';

const CRYPTO_TIMEOUT_MS = 2_000;

/** env 懒读（测试可在运行时改 env）。非法值按未配置处理。 */
export function resolveCryptoPort(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[CRYPTO_PORT_ENV];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

async function call(
  path: '/encrypt' | '/decrypt',
  body: Record<string, unknown>,
): Promise<string | null> {
  const port = resolveCryptoPort();
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CRYPTO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const value = path === '/encrypt' ? data['data'] : data['plaintext'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
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
