/**
 * 窗口显示闸门：「等页面加载完再显示」必须带兜底时限。
 *
 * 生产模式下窗口以 `show: false` 创建，靠 did-finish-load 才 show()——这样既不
 * 白闪，也保证 ARMS Browser SDK 只注入一次（见 main.js createWindow 的注释）。
 * 代价是：只要那次导航迟迟不结束，窗口就**永远**不可见——任务栏里没有它，用户点
 * 「切换知识库」看不到新窗口、点「设置」看不到任何反应，整个应用像是死的。
 *
 * 真实故障（2026-10-16，Windows v0.3.61-beta）：daemon 是单线程且同时托管 Web UI
 * 静态资源，整库冷索引（mac 实测 5000 文件 ≈ 6.3s，Windows + Defender 上更长）
 * 期间连自己托管的 index.html / chunk 请求都发不出去 → did-finish-load 迟迟不来。
 * daemon 侧已修（core/vault-search.ts 分片让位）；这里是壳层兜底：超时也先把窗口
 * 显示出来，页面渲染完会自己画上去。
 *
 * 刻意不额外加载任何「加载中」页面：那会占掉这个 webContents 的唯一一次导航，
 * ARMS SDK 的 per-webContents 去重会让真实应用注入不到（同 createWindow 的约定）。
 *
 * 纯逻辑、无 Electron 依赖；setTimeout/clearTimeout 可注入，便于单测。
 */
export const APP_LOAD_REVEAL_TIMEOUT_MS = 5000;

/**
 * @param {object} opts
 * @param {number} [opts.timeoutMs] 兜底时限
 * @param {(reason: 'loaded' | 'timeout') => void} [opts.onReveal] 显示窗口（只会被调一次）
 */
export function createRevealGate({
  timeoutMs = APP_LOAD_REVEAL_TIMEOUT_MS,
  onReveal,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  let revealed = false;
  let timer = null;

  function reveal(reason) {
    if (revealed) return false;
    revealed = true;
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    onReveal?.(reason);
    return true;
  }

  timer = setTimeoutFn(() => reveal('timeout'), timeoutMs);

  return {
    /** 页面加载完成（did-finish-load）→ 显示窗口。 */
    loaded: () => reveal('loaded'),
    /** 放弃兜底（窗口已销毁等）——不再触发 onReveal。 */
    cancel: () => {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },
  };
}
