/**
 * 阿里云 ARMS Electron SDK 接入（默认开启，无 UI 开关）。
 *
 * 1. SDK 静态 import + esbuild bundle：esbuild 比 Node 宽容，能解析
 *    `@arms/rum-core` ESM 入口里缺扩展名的内部 import（`./model/client`）；
 *    bundle 后所有传递依赖（@babel/runtime 等）inline 进单文件，绕开
 *    pnpm + electron-builder 传递依赖丢失问题。见 `scripts/prepare-resources.mjs`。
 * 2. `armsRum.init()` 在 `app.whenReady()` 后、非开发模式才调用。
 *    SDK 初始化失败写日志后吞掉，绝不影响应用启动。
 * 3. 脱敏层在 `monitoring-sanitize.js`（纯函数，可单测）。
 * 4. SDK 默认不采集 fetch/XHR body，对话内容不会上报。
 *
 * 单测见 `test/monitoring/sanitize.test.js`，只 import 纯函数（不 import 本文件，
 * 避免 SDK 加载链在测试环境下失败）。
 */

import armsRum from '@arms/rum-electron';
import { sanitizeBundle, sanitizeViewName, sanitizeResourceName, injectUserId } from './monitoring-sanitize.js';

// 从 ARMS 控制台「用户体验监控 → 应用列表 → 应用详情」获取的完整上报地址。
// SDK 会从 query string 里取 service_id 作为 app.id，不需要单独传 pid。
export const ARMS_ENDPOINT = 'https://j9lbfeoye3-default-cn.rum.aliyuncs.com/rum/web/v2?workspace=default-cms-1956699689590299-cn-hangzhou&service_id=j9lbfeoye3@81845ede792f278e256dc';

/**
 * 初始化 ARMS SDK。在 `app.whenReady()` 之后、createWindow 之前调用——
 * SDK autoInject 监听 web-contents-created 注入 Browser SDK，init 之前
 * 创建的窗口会错过注入。
 *
 * @param {{ isDev: boolean, version: string, log: Function, getUserId?: () => (string|null) }} opts
 *   `getUserId`：每次上报前被调用，返回当前登录的 Molio userId（ULID，未登录为
 *   null），注入 bundle.user.id。SDK 无 setUser API（0.0.5–0.0.7），beforeReport
 *   是唯一注入点；渲染进程事件也经主进程 reporter 上报，故此处覆盖全部事件。
 * @returns {Promise<object|null>} 初始化成功返回 armsRum 实例（truthy），否则 null
 */
export async function initMonitoring({ isDev, version, log, getUserId }) {
  if (isDev && !process.env.MOLIO_ARMS_DEV) {
    log('info', 'monitoring', 'skip ARMS init in dev mode (set MOLIO_ARMS_DEV=1 to force)');
    return null;
  }
  if (!ARMS_ENDPOINT || !/^https?:\/\//.test(ARMS_ENDPOINT)) {
    log('warn', 'monitoring', 'ARMS endpoint not configured. Visit ARMS console → 用户体验监控 → 应用列表 → 应用详情 to find the real endpoint URL.');
    return null;
  }
  try {
    await armsRum.init({
      endpoint: ARMS_ENDPOINT,
      env: isDev ? 'daily' : 'prod',
      version: version || '0.0.0',
      spaMode: 'history',
      autoInject: true,
      parseViewName: sanitizeViewName,
      parseResourceName: sanitizeResourceName,
      // 先脱敏再注入 userId。getUserId 缺省（或未传）时 injectUserId 原样返回。
      beforeReport: (bundle) => {
        const sanitized = sanitizeBundle(bundle);
        return injectUserId(sanitized, getUserId ? getUserId() : null);
      },
      collectors: {
        jsError: true,
        consoleError: true,
        crash: true,
        application: true,
        api: true,
        rpc: false,
        // Memory snapshots: samples app.getAppMetrics() every 10s,
        // aggregates into 30-min windows. Covers main process AND all
        // child processes (daemon, Claude CLI) with per-process
        // working_set / peak_working_set — essential for diagnosing
        // "app uses 2-3GB" reports.
        memory: true,
        // ANR detection: reports when the main-process event loop is
        // blocked 5s+. Includes a memory_pressure heuristic (system
        // available memory < 15%) that directly correlates with the
        // "machine freezes" symptom. Built-in rate limiting (same-source
        // 120s debounce, global 30min/5-event cap) prevents flooding.
        anr: true,
      },
      // Renderer-side Browser SDK collectors (autoInject-ed). Default has
      // longTask: true, but LoAF attribution is empty for V8 native work
      // (cold-start parse/compile of the 1MB+ JS bundle, GC) — the events
      // are noise that can't be debugged. Disable until we have a real
      // perf concern to chase.
      browserCollectors: {
        longTask: false,
      },
      offlineQueue: {
        enable: true,
        maxAgeDays: 7,
        // 100 was too small: daemon stderr noise (before tiered forwarding)
        // could fill the queue and push out valuable PV/API/error events.
        // 500 gives headroom for a full session's worth of events.
        maxQueueSize: 500,
      },
    });
    log('info', 'monitoring', `ARMS initialized (env=${isDev ? 'daily' : 'prod'}, version=${version || '0.0.0'})`);
    return armsRum;
  } catch (err) {
    log('error', 'monitoring', `init failed: ${err?.message ?? err}`);
    if (err?.stack) log('error', 'monitoring', err.stack);
    return null;
  }
}
