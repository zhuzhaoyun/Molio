/**
 * 已退役 —— 官网资源静态数据不再加载（官方资源全部迁移到云端市场 /market/listings）。
 * 本文件仅保留支付后端地址等运行时配置；MOLIO_RESOURCES 置空，官网列表/详情统一走云端。
 */
(function () {
  'use strict';

  // 微信支付后端地址（正式域名，已绑定 wxpay-fc 函数）。
  // 留空则付费资源降级为“联系购买”。测试可用 add_init_script 注入 localhost 覆盖。
  window.MOLIO_PAY_BASE = window.MOLIO_PAY_BASE || 'https://pay.molio.cn';

  // 旧版静态 OSS 下载根（官方资源直链），已退役——免费资源统一走市场签名下载。
  window.MOLIO_RES_BASE = 'https://molio-releases.oss-cn-guangzhou.aliyuncs.com/resources';

  // 静态官方资源数组已退役（官方资源迁移进云端市场），置空。
  window.MOLIO_RESOURCES = [];
})();