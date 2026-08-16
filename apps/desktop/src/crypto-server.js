/**
 * Electron 主进程 safeStorage 加密 HTTP 服务（用户模块 M4，设计 §十）。
 *
 * daemon 以 `ELECTRON_RUN_AS_NODE=1` 运行，拿不到 Electron API；主进程因此
 * 起一个 127.0.0.1 随机端口 HTTP server 暴露 encrypt/decrypt，端口在 spawn
 * daemon 时经 `MOLIO_DESKTOP_CRYPTO_PORT` env 注入。先例与模式同
 * wiki-fetcher.js 的 `startFetchServer`（MOLIO_DESKTOP_FETCH_PORT）。
 *
 * 契约（daemon 侧消费方 = apps/daemon/src/core/auth/desktop-crypto.ts）：
 *   POST /encrypt  { plaintext: string } → 200 { data: string }     // base64(safeStorage.encryptString(...))
 *   POST /decrypt  { data: string }      → 200 { plaintext: string }
 *   GET  /health                          → 200 { ok: true, available: boolean }
 *   加密不可用（Linux 无 keychain 等）→ 503；body 非法 → 400；body > 64KB → 413
 *   带密钥启动时 /encrypt /decrypt 必须携带 `Authorization: Bearer <secret>`，
 *   否则 401 unauthorized（/health 不鉴权，只透出可用性布尔）。
 *   daemon 侧把任何非 200 都当 null 处理，错误体只是给日志看的。
 *
 * safeStorage 函数经构造参数注入（不静态 import electron），本模块可在纯 Node
 * 测试里直接跑（测试用 mock safeStorage）。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const CRYPTO_HOST = '127.0.0.1';
// token JSON 最多几 KB；64KB 上限纯为防误用/恶意本机进程探测。
const MAX_BODY_BYTES = 64 * 1024;

/**
 * @typedef {object} CryptoImpl
 * @property {() => boolean} isEncryptionAvailable 映射 safeStorage.isEncryptionAvailable
 * @property {(plaintext: string) => Buffer} encryptString 映射 safeStorage.encryptString
 * @property {(data: Buffer) => string} decryptString 映射 safeStorage.decryptString（失败抛错）
 */

/**
 * 校验每次启动新生的共享密钥。随机端口本身不是安全边界——本机其他进程可以
 * 扫描/嗅探到它——密钥才是防止它们冒用 encrypt/decrypt 的闸门。
 * RFC 6750：Bearer scheme 大小写不敏感。等长时 timingSafeEqual 常量时间比较。
 *
 * @param {string | string[] | undefined} authHeader req.headers.authorization
 * @param {string | undefined} token 服务启动时注入的密钥；未配置则不鉴权（测试/向后兼容）
 */
function isAuthorized(authHeader, token) {
  if (!token) return true;
  if (typeof authHeader !== 'string') return false;
  const match = /^bearer (.+)$/i.exec(authHeader);
  if (!match) return false;
  const given = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * 构造请求 handler。抽成工厂以便单测注入 mock safeStorage。
 * @param {CryptoImpl} crypto
 * @param {{ token?: string }} [opts] token = main.js 每次启动注入的共享密钥（见 isAuthorized）
 */
export function createCryptoRequestHandler(crypto, opts = {}) {
  const token = opts.token;
  return function handleRequest(req, res) {
    // 客户端 socket 异常断开时 res 写入会以 ECONNRESET 抛错；挂 error 监听
    // 避免未处理错误崩溃主进程。
    res.on('error', () => {});

    if (req.method === 'GET' && req.url === '/health') {
      let available = false;
      try {
        available = crypto.isEncryptionAvailable();
      } catch {
        available = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, available }));
      return;
    }

    if (req.method !== 'POST' || (req.url !== '/encrypt' && req.url !== '/decrypt')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Buffer chunk 累积、收完才解码：逐 chunk 字符串拼接会把跨 chunk 边界的多字节
    // UTF-8 字符解坏（U+FFFD 乱码），且 string.length 是 UTF-16 单元数不是字节数，
    // 尺寸闸门会失真（多字节内容可 3 倍超限而不触发 413）。
    const chunks = [];
    let byteLength = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return; // 继续排空 socket 但不再累积内存
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buf.length;
      if (byteLength > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0; // 释放
        return;
      }
      chunks.push(buf);
    });
    // body 中途 socket 出错：停止累积。挂监听本身防止未处理 error 崩溃主进程；
    // 若连接随后仍走到 'end'（如测试驱动），按超限处理安全回 413。
    req.on('error', () => {
      oversized = true;
      chunks.length = 0;
    });
    req.on('end', () => {
      // 超限在 body 收完后才回 413：若边读边 destroy，响应可能还没冲刷出
      // socket 就被掐断，客户端看到的是 ECONNRESET 而非 413（不确定行为）。
      if (oversized) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }

      let available = false;
      try {
        available = crypto.isEncryptionAvailable();
      } catch {
        available = false;
      }
      if (!available) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'crypto_unavailable' }));
        return;
      }

      if (req.url === '/encrypt') {
        const plaintext = payload && payload.plaintext;
        if (typeof plaintext !== 'string' || plaintext === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_plaintext' }));
          return;
        }
        try {
          const encrypted = crypto.encryptString(plaintext);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: Buffer.from(encrypted).toString('base64') }));
        } catch {
          // 错误体不带 errMsg：message 可能含 OS/keychain 细节，daemon 侧把任何
          // 非 200 都当 null，不区分错误种类，细节只对本地日志有价值。
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'encrypt_failed' }));
        }
        return;
      }

      // /decrypt
      const data = payload && payload.data;
      if (typeof data !== 'string' || data === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_data' }));
        return;
      }
      try {
        const plaintext = crypto.decryptString(Buffer.from(data, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plaintext }));
      } catch {
        // 跨机器复制的信封、损坏数据、keychain 被锁 → daemon 侧按未登录处理，
        // 文件保留可恢复。400 只是信号，daemon 不区分错误种类。
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'decrypt_failed' }));
      }
    });
  };
}

let server = null;

/**
 * 启动加密服务（127.0.0.1 随机端口）。返回端口号；main.js 经 env 传给 daemon。
 * @param {CryptoImpl} crypto
 * @param {{ token?: string }} [opts] token = 每次启动新生的共享密钥。设置时与端口
 *   一起注入 daemon env（MOLIO_DESKTOP_CRYPTO_TOKEN），daemon 调用带 Bearer
 *   （desktop-crypto.ts），本服务逐次校验，防本机他进程冒用。
 * @returns {Promise<number>}
 */
export function startCryptoServer(crypto, opts = {}) {
  return new Promise((resolve, reject) => {
    server = http.createServer(createCryptoRequestHandler(crypto, opts));
    server.on('error', (err) => {
      reject(err);
    });
    server.listen(0, CRYPTO_HOST, () => {
      const port = server.address().port;
      resolve(port);
    });
  });
}

export async function stopCryptoServer() {
  await new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
