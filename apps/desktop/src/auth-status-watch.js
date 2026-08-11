/**
 * 轮询 daemon `/api/auth/status`，把 Molio userId 变化同步给 ARMS 注入层
 * （用户模块 M4，设计 §十一）。
 *
 * 背景：ARMS SDK（@arms/rum-electron 0.0.5–0.0.7）**没有 setUser API**——
 * reporter 组 bundle 时 `user.id` 只取内部 session 的匿名设备 UID，且
 * `config.user.id` 被显式跳过。唯一干净注入点 = `beforeReport(bundle)` 钩子，
 * main.js 在那里读本模块维护的 userId（见 monitoring.js 的 getUserId 参参）。
 *
 * 设计要点：
 * - `/api/auth/status` 是纯本地快照（daemon 不发网络请求），15s 轮询成本可忽略。
 * - 记忆 lastUserId，**只在变化时**触发 onUser（登录/登出/切换账号三种转换）。
 *   初始状态是 null，所以首次观察到已登录用户也会触发一次。
 * - daemon 不可达（启动中/重启中）静默跳过——绝不把"daemon 暂时挂了"误判为登出。
 * - userId 只取 user.id（ULID，不含邮箱）：监控归因不需要也不允许带 PII。
 *
 * Uses console.log (stdout) via injected log, NOT console.warn/error (stderr) —
 * cloud log collectors classify stderr as ERROR.
 */

const DEFAULT_INTERVAL_MS = 15_000;
// 与 daemon-metrics.js 同款防护：setInterval 会把 <=0 夹到 1ms，
// 误配的超短间隔会变成对 daemon 的请求风暴。
const MIN_INTERVAL_MS = 1_000;

/** env 覆盖轮询间隔（排障/测试用）。 */
export const AUTH_STATUS_INTERVAL_ENV = 'MOLIO_AUTH_STATUS_INTERVAL_MS';

/**
 * 从原始 env 值解析轮询间隔。负数/零/低于下限/非数字一律回落默认 15s。
 * （Number('-1') 是 truthy，`Number(x) || fallback` 会漏负数——同 daemon-metrics 教训。）
 *
 * @param {string | undefined} rawValue
 * @returns {number} interval in milliseconds
 */
export function resolveIntervalMs(rawValue) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS ? parsed : DEFAULT_INTERVAL_MS;
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

  const poll = async () => {
    let userId = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const status = await res.json();
      if (status && status.loggedIn === true && status.user && typeof status.user.id === 'string') {
        userId = status.user.id;
      }
    } catch {
      // daemon 不可达 / 响应坏掉 → 静默，保持上次状态（不误判登出）。
      return;
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
    clearInterval(timer);
  };
}
