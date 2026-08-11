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
 *   daemon 侧把任何非 200 都当 null 处理，错误体只是给日志看的。
 *
 * safeStorage 函数经构造参数注入（不静态 import electron），本模块可在纯 Node
 * 测试里直接跑（测试用 mock safeStorage）。
 */

import http from 'node:http';

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
 * 构造请求 handler。抽成工厂以便单测注入 mock safeStorage。
 * @param {CryptoImpl} crypto
 */
export function createCryptoRequestHandler(crypto) {
  return function handleRequest(req, res) {
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

    let buf = '';
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return; // 继续排空 socket 但不再累积内存
      buf += chunk;
      if (buf.length > MAX_BODY_BYTES) {
        oversized = true;
        buf = ''; // 释放
      }
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
        payload = JSON.parse(buf || '{}');
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
        } catch (err) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'encrypt_failed', message: errMsg(err) }));
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
 * @returns {Promise<number>}
 */
export function startCryptoServer(crypto) {
  return new Promise((resolve, reject) => {
    server = http.createServer(createCryptoRequestHandler(crypto));
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

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
