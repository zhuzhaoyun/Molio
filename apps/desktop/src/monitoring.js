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
 * 5. SDK 0.0.5 的 electron-reporter.request() 有 promise 泄漏：上报请求失败会
 *    触发 unhandledRejection，被 SDK 自己的异常采集器再次上报（"TypeError:
 *    fetch failed" 自报噪音）。根治靠 `patches/@arms__rum-electron@0.0.5.patch`
 *    （pnpm patchedDependencies 在 install 时打入 node_modules）；beforeReport
 *    里的 dropFetchFailedNoise 是兜底过滤。校验测试见
 *    `test/monitoring/arms-sdk-patch.test.js`。
 *
 * 单测见 `test/monitoring/sanitize.test.js`，只 import 纯函数（不 import 本文件，
 * 避免 SDK 加载链在测试环境下失败）。
 */

import armsRum from '@arms/rum-electron';
import { sanitizeBundle, sanitizeViewName, sanitizeResourceName, dropFetchFailedNoise } from './monitoring-sanitize.js';

// 从 ARMS 控制台「用户体验监控 → 应用列表 → 应用详情」获取的完整上报地址。
// SDK 会从 query string 里取 service_id 作为 app.id，不需要单独传 pid。
export const ARMS_ENDPOINT = 'https://j9lbfeoye3-default-cn.rum.aliyuncs.com/rum/web/v2?workspace=default-cms-1956699689590299-cn-hangzhou&service_id=j9lbfeoye3@81845ede792f278e256dc';

/**
 * 初始化 ARMS SDK。在 `app.whenReady()` 之后、createWindow 之前调用——
 * SDK autoInject 监听 web-contents-created 注入 Browser SDK，init 之前
 * 创建的窗口会错过注入。
 *
 * @param {{ isDev: boolean, version: string, log: Function }} opts
 * @returns {Promise<object|null>} 初始化成功返回 armsRum 实例（truthy），否则 null
 */
export async function initMonitoring({ isDev, version, log }) {
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
      // 先丢掉 SDK 自报噪音（fetch failed 自循环异常），再脱敏。
      // dropFetchFailedNoise 返回 null 时 sanitizeBundle 原样返回 null，
      // SDK 收到 falsy 会跳过本次上报。
      beforeReport: (bundle) => sanitizeBundle(dropFetchFailedNoise(bundle)),
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
