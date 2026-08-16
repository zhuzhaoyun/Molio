/**
 * 轮询间隔 env 覆盖的统一解析（auth-status-watch.js 与 daemon-metrics.js 共用）。
 *
 * 背景：setInterval 会把 <=0 的值夹到 1ms，误配的超短间隔会变成对 daemon 的
 * 请求风暴。且 JS 里 Number('-1') 是 truthy，naive 的 `Number(x) || fallback`
 * 会漏掉负数。因此要求「有限 且 >= 下限」，否则回落调用方给定的默认值。
 *
 * 两个轮询器曾各自内联同一份实现（含同款注释与同款测试），现收敛到此处；
 * 各自的默认间隔（15s / 60s）仍由调用方传入，本模块不持有业务默认值。
 */

/** 生产下限：任何轮询不得快于每秒一次。 */
export const MIN_POLL_INTERVAL_MS = 1_000;

/**
 * 从原始 env 值解析轮询间隔。负数/零/低于下限/非数字/undefined 一律回落 defaultMs。
 *
 * @param {string | undefined} rawValue 原始 env 字符串（未设置时为 undefined）
 * @param {number} defaultMs 该轮询器的默认间隔
 * @param {number} [minMs] 允许的最小间隔，默认 MIN_POLL_INTERVAL_MS
 * @returns {number} interval in milliseconds
 */
export function resolvePollIntervalMs(rawValue, defaultMs, minMs = MIN_POLL_INTERVAL_MS) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= minMs ? parsed : defaultMs;
}
