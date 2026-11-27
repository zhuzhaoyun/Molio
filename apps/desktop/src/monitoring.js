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
 * 5. 上报量降本（免费额度用完后 ARMS 按上报量计费，本项目监控使用不多）：
 *    - 采集器只保留低频高价值项，高频低价值项显式关闭（见下方 collectors /
 *      browserCollectors 注释）；渲染端 ie(ctx,name) 对未配置项默认 true，故必须逐个关。
 *    - beforeReport 里 dropNoiseEvents 先丢掉已知良性异常（网络抖动 / Vite chunk /
 *      MathJax·代码主题·启动竞态降级），再脱敏、注入 userId。详见 monitoring-sanitize.js。
 *    - SDK 0.0.5 electron-reporter.request() 的 promise 泄漏（"TypeError: fetch failed"
 *      自报噪音）上游 0.0.7 已修，本地 patch 已撤；dropNoiseEvents 的 /fetch failed/
 *      保留为兜底。回归防线见 `test/monitoring/arms-sdk-fetch-leak.test.js`。
 *    - 会话采样率 session.sampling 由 ARMS 控制台远程配置下发（非本文件），可在控制台直接调低。
 *
 * 单测见 `test/monitoring/sanitize.test.js`，只 import 纯函数（不 import 本文件，
 * 避免 SDK 加载链在测试环境下失败）。
 */

import armsRum from '@arms/rum-electron';
import { sanitizeBundle, sanitizeViewName, sanitizeResourceName, injectUserId, dropNoiseEvents } from './monitoring-sanitize.js';

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
      // 先丢掉已知良性异常（网络抖动 / chunk / 降级），再脱敏，最后注入 userId。
      // dropNoiseEvents 返回 null 时一路原样返回 null（sanitizeBundle /
      // injectUserId 对 null 均不改写），SDK 收到 falsy 会跳过本次上报。
      // getUserId 缺省（或未传）时 injectUserId 原样返回。
      beforeReport: (bundle) => {
        const sanitized = sanitizeBundle(dropNoiseEvents(bundle));
        return injectUserId(sanitized, getUserId ? getUserId() : null);
      },
      collectors: {
        jsError: true,
        consoleError: true,
        crash: true,
        application: true,
        // 主进程 fetch 全是 localhost 轮询（auth-status 15s / 曾经的 metrics 60s /
        // /api/shutdown）——监控自家本地 daemon 的 API 延迟无诊断价值，纯烧额度。
        api: false,
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
      // 渲染端 Browser SDK 采集器（autoInject 注入）。SDK 的 ie(ctx,name) 对
      // **未显式配置的采集器默认返回 true**——所以 click/action/staticResource/api/
      // perf/webvitals 全都在默认上报，是本地优先应用最大的上报量来源，且几乎无诊断
      // 价值。这里逐个显式关掉，只保留 exception(jsError+consoleError) 与 whiteScreen：
      //   - click        每次点击都上报（交互密集，量最大）
      //   - action       每个动作/路由
      //   - staticResource 每张图片/CSS/JS/字体（KB 渲染 md 图 + 代码主题 + MathJax + PDF.js + Pixi）
      //   - api          每次 fetch，全是 localhost:3100
      //   - perf/webvitals 页面加载计时 / LCP·CLS·FID，对 Electron 本地页无意义
      //   - longTask     LoAF 归因对 V8 native work（冷启动 parse/compile、GC）为空，纯噪音
      // 保留项：exception（"过滤后异常"——良性项已在 dropNoiseEvents + 源码 console.warn 处理）、
      // whiteScreen（低频高价值，白屏 bug 探测）。
      browserCollectors: {
        longTask: false,
        click: false,
        action: false,
        staticResource: false,
        api: false,
        perf: false,
        webvitals: false,
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
