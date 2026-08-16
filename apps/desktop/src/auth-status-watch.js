/**
 * 轮询 daemon `/api/auth/status`，把 Molio userId 变化同步给 ARMS 注入层
 * （用户模块 M4，设计 §十一）。
 *
 * 背景：ARMS SDK（@arms/rum-electron 0.0.5–0.0.7）**没有 setUser API**——
 * reporter 组 bundle 时 `user.id` 只取内部 session 的匿名设备 UID，且
 * `config.user.id` 被显式跳过。唯一干净注入点 = `beforeReport(bundle)` 钩子，
 * main.js 在那里读本模块维护的 userId（见 monitoring.js 的 getUserId 参数）。
 *
 * 设计要点：
 * - `/api/auth/status` 是纯本地快照（daemon 不发网络请求），15s 轮询成本可忽略。
 * - 记忆 lastUserId，**只在变化时**触发 onUser（登录/登出/切换账号三种转换）。
 *   初始状态是 null，所以首次观察到已登录用户也会触发一次。
 * - daemon 不可达（启动中/重启中）静默跳过——绝不把"daemon 暂时挂了"误判为登出。
 * - 响应是合法 JSON 但形状坏掉（{}、loggedIn:true 缺 user.id 等）同样静默——
 *   只有明确的 `loggedIn === false` 才构成登出转换，歧义快照保持上次状态。
 * - in-flight 守卫：daemon 响应慢于轮询间隔时跳过新一轮，防止请求无限堆叠。
 * - stop() 立即中止在途请求（AbortController），不是只清定时器。
 * - userId 只取 user.id（ULID，不含邮箱）：监控归因不需要也不允许带 PII。
 *
 * Uses console.log (stdout) via injected log, NOT console.warn/error (stderr) —
 * cloud log collectors classify stderr as ERROR.
 */

import { resolvePollIntervalMs } from './polling-interval.js';

const DEFAULT_INTERVAL_MS = 15_000;

/** 单次请求超时（daemon 本地快照接口，5s 足够宽裕）。 */
const FETCH_TIMEOUT_MS = 5_000;

/** env 覆盖轮询间隔（排障/测试用）。 */
export const AUTH_STATUS_INTERVAL_ENV = 'MOLIO_AUTH_STATUS_INTERVAL_MS';

/**
 * 从原始 env 值解析轮询间隔。负数/零/低于下限/非数字一律回落默认 15s。
 * 解析规则（含负数 truthy 陷阱的防护）统一在 polling-interval.js。
 *
 * @param {string | undefined} rawValue
 * @returns {number} interval in milliseconds
 */
export function resolveIntervalMs(rawValue) {
  return resolvePollIntervalMs(rawValue, DEFAULT_INTERVAL_MS);
}

/**
 * 开始轮询 daemon 登录态。
 *
 * @param {{ daemonPort?: number, onUser: (userId: string|null) => void, log: Function, intervalMs?: number }} opts
 *   `intervalMs` 覆盖 env 推导的间隔，测试用（可低于生产的 1s 下限）。
 * @returns {() => void} stop 函数
 */
export function startAuthStatusPolling({ daemonPort = 3100, onUser, log, intervalMs }) {
  const effectiveInterval =
    intervalMs ?? resolveIntervalMs(process.env[AUTH_STATUS_INTERVAL_ENV]);
  const url = `http://localhost:${daemonPort}/api/auth/status`;
  let lastUserId = null;
  // 上一轮还没回来（daemon 慢）→ 跳过本轮，防止请求在快间隔下无限堆叠。
  let inFlight = false;
  // stop() 时中止在途 fetch：只清定时器的话，退出瞬间发出的请求还会继续跑完。
  const stopController = new AbortController();

  const poll = async () => {
    if (inFlight || stopController.signal.aborted) return;
    inFlight = true;
    let userId = null;
    try {
      const res = await fetch(url, {
        // stop() 中止与单次请求超时合并为一个 signal。
        signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
      if (!res.ok) return;
      const status = await res.json();
      if (status && status.loggedIn === true) {
        if (status.user && typeof status.user.id === 'string') {
          userId = status.user.id;
        } else {
          // loggedIn:true 却缺 user.id：歧义快照，保持上次状态（不下调为登出）
          return;
        }
      } else if (!status || status.loggedIn !== false) {
        // 既非 loggedIn:true 也非 loggedIn:false（如 {}）：坏形状，静默保持上次状态
        return;
      }
      // loggedIn === false → userId 保持 null（明确的登出转换）
    } catch {
      // daemon 不可达 / 响应坏掉 / stop() 中止 → 静默，保持上次状态（不误判登出）。
      return;
    } finally {
      inFlight = false;
    }
    if (userId !== lastUserId) {
      lastUserId = userId;
      try {
        onUser(userId);
      } catch (err) {
        log('warn', 'auth-status-watch', `onUser callback threw: ${err && err.message || err}`);
      }
      log('info', 'auth-status-watch', userId ? `user logged in (id=${userId})` : 'user logged out');
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, effectiveInterval);
  // 不阻止进程退出（与 daemon-metrics 对称）。
  timer.unref();
  // 启动即查一次：用户带登录态启动应用时不必等第一个间隔。
  void poll();

  log('info', 'auth-status-watch', `polling ${url} every ${Math.round(effectiveInterval / 1000)}s`);

  return () => {
    stopController.abort();
    clearInterval(timer);
  };
}
