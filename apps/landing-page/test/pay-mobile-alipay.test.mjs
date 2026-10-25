// pay.js 手机端支付宝支付分支测试（node:test）。
//
// 背景：手机上 Native 扫码不可用（微信已封禁长按/相册识别二维码），微信 H5 支付
// 申请未通过且 App 内置浏览器唤端不稳定。因此手机（微信外，含 B 站）改走支付宝
// 手机网站支付（WAP）：后端返回 pay_url，前端整页跳转，付完回跳续接。
//
// 无真实 DOM / 网络 / 定时器：桩 window/document/location/navigator/sessionStorage/
// fetch/QRCode/setInterval，用 setImmediate 驱动 pay.js 的 promise 链。
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAY_JS = readFileSync(path.join(here, '..', 'pay.js'), 'utf8');

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_BILI = 'Mozilla/5.0 (Linux; Android 13; PGT-AN10 Build/HONORPGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 BiliApp/76000100';
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_WECHAT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN';

const PAY_BASE = 'https://pay.molio.cn';
const ALIPAY_URL = 'https://openapi.alipay.com/gateway.do?app_id=2021000000000000&method=alipay.trade.wap.pay&sign=xyz';
const OUT_TRADE_NO = 'consulting1700000000ab';
const PAGE_URL = 'https://molio.cn/resource/consulting.html';

/** 冲刷微任务队列：pay.js 的 fetch 链全是 promise，需要多轮 setImmediate 才落定 */
async function flushAll() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/**
 * 以浏览器桩加载 pay.js。
 *
 * @param {object} [opts]
 * @param {string} [opts.ua]             navigator.userAgent
 * @param {string} [opts.search]          location.search（回跳参数走这里）
 * @param {string} [opts.pathname]        location.pathname
 * @param {object} [opts.listing]         window.__LISTING__（SSR 商品页内嵌数据）
 * @param {object} [opts.auth]            window.MolioAuth 桩（如 getUser）
 * @param {(url: string) => ({status:number, body:object}|null)} [opts.respond] 按 URL 决定响应
 * @returns 桩环境句柄
 */
function loadPay(opts = {}) {
  const {
    ua = UA_MOBILE,
    search = '',
    pathname = '/resource/consulting.html',
    listing = { id: 'consulting', priceCents: 4900 },
    auth = null,
    respond = () => null,
    store = new Map(),   // 复用同一个 store 可模拟「同一标签页重新加载」
  } = opts;

  const registry = new Map();
  const fetchCalls = [];
  const qrCalls = [];
  const timers = new Map();
  const historyCalls = [];
  const docListeners = new Map();
  let timerSeq = 0;

  function makeNode(tag) {
    const listeners = new Map();
    const node = {
      tag, id: '', hidden: false, src: '', href: '', textContent: '', className: '',
      style: {}, dataset: {}, children: [],
      _innerHTML: '',
      _listeners: listeners,
      setAttribute() {},
      addEventListener(type, fn) { const l = listeners.get(type) || []; l.push(fn); listeners.set(type, l); },
      appendChild(c) { node.children.push(c); return c; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    // innerHTML setter：把每个 id="..." 注册进 registry，并按标签内是否带 hidden 属性初始化 hidden
    // （pay.js 构建后按 id 取节点，断言 hidden 才有意义）
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._innerHTML; },
      set(html) {
        node._innerHTML = html;
        const re = /id="([^"]+)"([^>]*)>/g;
        let m;
        while ((m = re.exec(html))) {
          if (!registry.has(m[1])) {
            const stub = makeNode('div');
            stub.id = m[1];
            stub.hidden = /\bhidden\b/.test(m[2]);
            registry.set(m[1], stub);
          }
        }
      },
    });
    return node;
  }

  const body = makeNode('body');
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const location = { pathname, origin: 'https://molio.cn', href: PAGE_URL + search };
  Object.defineProperty(location, 'search', { get: () => search, enumerable: true });

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    currentScript: { src: 'https://molio.cn/pay.js?v=20261025a' },
    createElement: makeNode,
    getElementById: (id) => registry.get(id) || null,
    body,
    addEventListener(type, fn) { const l = docListeners.get(type) || []; l.push(fn); docListeners.set(type, l); },
  };

  const window = {
    addEventListener() {},
    history: { replaceState(...args) { historyCalls.push(args); } },
    MOLIO_PAY_BASE: PAY_BASE,
    __LISTING__: listing,
  };
  if (auth) window.MolioAuth = auth;

  // 网络桩：按 respond 决定；未命中返回 404（pay.js 会走失败分支）
  const fetchImpl = (url) => {
    const u = String(url);
    fetchCalls.push(u);
    const r = respond(u);
    if (!r) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: r.status === 200, status: r.status, json: async () => r.body });
  };

  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let realNavigator;

  globalThis.fetch = fetchImpl;
  globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; };
  globalThis.clearInterval = (id) => { timers.delete(id); };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = location;
  globalThis.sessionStorage = sessionStorage;
  // Node 21+ 自带只读的 navigator，赋值会抛错 → 用 defineProperty 覆盖
  realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
  // 桌面路径与旧后端兜底才会用到二维码渲染；用桩记录调用（手机支付宝路径不该碰它）
  globalThis.QRCode = function QRCode(el, o) { qrCalls.push({ el, ...o }); };
  globalThis.QRCode.CorrectLevel = { M: 'M' };

  new Function(PAY_JS)();

  return {
    window, document, location, sessionStorage, registry,
    fetchCalls, qrCalls, timers, historyCalls,
    payCalls: () => fetchCalls.filter((u) => u.includes('/pay?')),
    orderCalls: () => fetchCalls.filter((u) => u.includes('/order?')),
    deliverCalls: () => fetchCalls.filter((u) => u.includes('/deliver?')),
    node: (id) => registry.get(id),
    modalHtml: () => (body.children[0] || {})._innerHTML || '',   // 弹窗本体走 createElement，不在 registry 里
    titleText: () => (registry.get('pay-title') || {}).textContent || '',
    tipText: () => (registry.get('pay-tip') || {}).textContent || '',
    downloadHref: () => (registry.get('pay-dl') || {}).href || '',
    retryHidden: () => (registry.get('pay-retry') || {}).hidden,
    savedPending: () => { try { return JSON.parse(store.get('molio_pay_pending')); } catch (e) { return null; } },
    /** 触发 document 上的监听（如 visibilitychange），模拟从支付宝切回浏览器 */
    emitDocument(type) { for (const fn of docListeners.get(type) || []) fn({ type }); },
    /** 点击某个桩节点（如 pay-retry） */
    click(id) {
      const n = registry.get(id);
      for (const fn of (n && n._listeners.get('click')) || []) fn({ target: n });
    },
    flushAll,
    restore() {
      globalThis.fetch = realFetch;
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.location;
      delete globalThis.sessionStorage;
      delete globalThis.QRCode;
      if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
      else delete globalThis.navigator;
    },
  };
}

/** 下单 + 查单的通用响应：/pay 按 scene 分支返回，/order 与 /deliver 默认成功 */
function payRespond() {
  let orderStatus = 'NOTPAY';
  const respond = (url) => {
    if (url.includes('/pay?')) {
      return url.includes('scene=alipay')
        ? { status: 200, body: { pay_url: ALIPAY_URL, out_trade_no: OUT_TRADE_NO, amount: 4900 } }
        : { status: 200, body: { code_url: 'weixin://wxpay/bizpayurl?pr=ABC123', out_trade_no: OUT_TRADE_NO, amount: 4900 } };
    }
    if (url.includes('/order?')) return { status: 200, body: { status: orderStatus } };
    if (url.includes('/deliver?')) return { status: 200, body: { url: 'https://molio-pay.oss-cn-guangzhou.aliyuncs.com/resources/x.zip?sig=1' } };
    return null;
  };
  return { respond, setPaid() { orderStatus = 'SUCCESS'; } };
}

test('手机端（B站 WebView）：下单带 scene=alipay → 跳支付宝收银台，不渲染二维码', async () => {
  const { respond } = payRespond();
  const h = loadPay({ ua: UA_BILI, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();

    const payCall = h.payCalls()[0];
    assert.ok(payCall, '发起了下单请求');
    assert.ok(payCall.includes('scene=alipay'), '手机端显式声明 scene=alipay');
    assert.ok(payCall.includes('id=consulting'));
    assert.ok(payCall.includes('return_url=' + encodeURIComponent(PAGE_URL)), '回跳页交给后端拼订单号');

    assert.equal(h.qrCalls.length, 0, '手机端不渲染二维码');
    assert.equal(h.location.href, ALIPAY_URL, '整页跳转到支付宝收银台');
    assert.equal(h.titleText(), '支付宝支付', '弹窗标题是支付宝，不是微信');

    // 待付订单落盘（回跳参数丢失时的兜底）
    const saved = h.savedPending();
    assert.equal(saved.id, 'consulting');
    assert.equal(saved.no, OUT_TRADE_NO);

    assert.equal(h.retryHidden(), false, '给了「重新支付」入口（从支付宝回退时可见）');
  } finally {
    h.restore();
  }
});

test('桌面端：仍走 Native 扫码，一行不变（回归保护）', async () => {
  const { respond } = payRespond();
  const h = loadPay({ ua: UA_DESKTOP, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();

    const payCall = h.payCalls()[0];
    assert.ok(payCall, '发起了下单请求');
    assert.ok(!payCall.includes('scene='), '桌面不带 scene（后端仍走 Native）');
    assert.ok(!payCall.includes('return_url='), '桌面不传支付宝回跳地址');

    assert.equal(h.qrCalls.length, 1, '桌面渲染二维码');
    assert.equal(h.qrCalls[0].text, 'weixin://wxpay/bizpayurl?pr=ABC123', '二维码内容为 code_url');
    assert.equal(h.location.href, PAGE_URL, '桌面不跳转');
    assert.equal(h.timers.size, 1, '桌面起 3s 轮询');
    assert.ok(h.tipText().includes('扫码支付'), '桌面文案仍为扫码');
    assert.equal(h.titleText(), '微信支付', '桌面标题仍为微信支付');
    assert.equal(h.retryHidden(), true, '桌面不显示「重新支付」');
  } finally {
    h.restore();
  }
});

test('微信内：不创建订单、不渲染二维码，只引导去浏览器打开', async () => {
  const { respond } = payRespond();
  const h = loadPay({ ua: UA_WECHAT, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();

    assert.equal(h.payCalls().length, 0, '微信内不创建订单（支付宝被微信屏蔽，下单也无法支付）');
    assert.equal(h.qrCalls.length, 0, '不再画一个微信内识别不了的二维码');
    assert.equal(h.location.href, PAGE_URL, '不跳转');
    assert.ok(h.tipText().includes('在浏览器中打开'), '引导用户到浏览器');
    assert.equal(h.titleText(), '请在浏览器中打开');
  } finally {
    h.restore();
  }
});

test('手机端从支付宝切回：立刻补查一次（不等 3s），未支付时提示可重新支付', async () => {
  const { respond } = payRespond();
  const h = loadPay({ ua: UA_MOBILE, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();
    assert.equal(h.orderCalls().length, 0, '跳转前不轮询（页面已卸载，轮询无意义）');

    // 用户从支付宝按返回键回到本页（bfcache 恢复），触发 visibilitychange
    h.emitDocument('visibilitychange');
    await flushAll();

    assert.equal(h.orderCalls().length, 1, '切回时立刻补查，不等下一个 3s');
    assert.ok(h.tipText().includes('重新支付'), '未支付时给出重新支付引导');
  } finally {
    h.restore();
  }
});

test('切回后查到 SUCCESS：解锁下载并展示加群二维码', async () => {
  const { respond, setPaid } = payRespond();
  const h = loadPay({ ua: UA_MOBILE, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();

    setPaid();
    h.emitDocument('visibilitychange');
    await flushAll();

    assert.ok(h.deliverCalls().length === 1, '支付成功后换取下载链接');
    assert.ok(h.downloadHref().includes('x.zip'), '下载链接就绪');
    assert.equal(h.node('pay-dl').hidden, false, '下载按钮显示');
    assert.equal(h.node('pay-group').hidden, false, '交付时刻展示加群二维码');
    assert.equal(h.retryHidden(), true, '成功后隐藏重新支付');
    assert.equal(h.savedPending(), null, '待付记录已清理，不再续接打扰');
  } finally {
    h.restore();
  }
});

test('支付宝回跳续接（return_url 带参数）：直接查单解锁，不重新下单', async () => {
  const { respond, setPaid } = payRespond();
  setPaid();
  const h = loadPay({
    ua: UA_MOBILE,
    search: `?molio_pay_resume=consulting~${OUT_TRADE_NO}`,
    respond,
  });
  try {
    await flushAll(); // buildModal 末尾 takePending() → resumeOrder() → checkOrder()

    assert.equal(h.payCalls().length, 0, '续接不重新下单（也就不会重复弹登录框）');
    assert.equal(h.orderCalls().length, 1, '直接查单');
    assert.equal(h.deliverCalls().length, 1);
    assert.ok(h.downloadHref().includes('x.zip'), '回来即解锁下载');
    assert.ok(h.location.href.includes('/resource/consulting.html'), '续接不触发跳转');
    assert.equal(h.historyCalls.length, 1, '回跳参数已从地址栏抹掉（刷新不重复触发）');
  } finally {
    h.restore();
  }
});

test('回跳续接（参数丢失，靠 sessionStorage 兜底）：未支付 → 轮询 + 重新支付再走支付宝', async () => {
  const { respond } = payRespond();
  const store = new Map();   // 两个 h 共用一个 sessionStorage，模拟同一标签页重新加载
  const h = loadPay({ ua: UA_MOBILE, search: '', respond, store });
  try {
    // 模拟「跳转前已落盘」：先下一次单（写入 pending），再重载页面（不带参数）
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();
    const saved = h.savedPending();
    assert.ok(saved && saved.no === OUT_TRADE_NO, '跳转前已落盘');

    const h2 = loadPay({ ua: UA_MOBILE, search: '', respond, store });
    try {
      await flushAll();
      assert.equal(h2.payCalls().length, 0, '靠落盘记录续接，不重新下单');
      assert.equal(h2.orderCalls().length, 1, '直接查单');
      assert.equal(h2.retryHidden(), false, '未支付 → 给重新支付入口');
      assert.ok(h2.tipText().includes('重新支付'), '提示可重新支付');
      assert.equal(h2.timers.size, 1, '转入 3s 轮询');

      // 点「重新支付」→ 重新下单拿新的支付宝链接
      h2.click('pay-retry');
      await flushAll();
      assert.equal(h2.payCalls().length, 1, '重新下单');
      assert.ok(h2.payCalls()[0].includes('scene=alipay'), '仍是支付宝通道');
      assert.ok(h2.payCalls()[0].includes('return_url='), '重新下单仍带回跳地址');
    } finally {
      h2.restore();
    }
  } finally {
    h.restore();
  }
});

test('续接后重新支付：从本地登录态补回 uid，买家归属不丢', async () => {
  const { respond } = payRespond();
  const h = loadPay({
    ua: UA_MOBILE,
    search: `?molio_pay_resume=consulting~${OUT_TRADE_NO}`,
    respond,
    auth: {
      getUser: () => ({ id: 'user-1', email: 'a@b.c' }),
      requireAuth: () => Promise.resolve({ id: 'user-1' }),
    },
  });
  try {
    await flushAll();       // 续接：查单（未支付）→ 轮询
    h.click('pay-retry');
    await flushAll();
    assert.equal(h.payCalls().length, 1, '重新下单');
    assert.ok(h.payCalls()[0].includes('uid=user-1'), 'uid 从登录态补回，订单仍归属买家');
  } finally {
    h.restore();
  }
});

test('旧后端只有 code_url：手机端降级为「另一台设备扫码」，并说清楚本机扫不了', async () => {
  const respond = (url) => {
    if (url.includes('/pay?')) return { status: 200, body: { code_url: 'weixin://wxpay/bizpayurl?pr=OLD', out_trade_no: OUT_TRADE_NO } };
    if (url.includes('/order?')) return { status: 200, body: { status: 'NOTPAY' } };
    return null;
  };
  const h = loadPay({ ua: UA_MOBILE, respond });
  try {
    h.window.MolioPay.open({ id: 'consulting', price: 49 });
    await flushAll();

    assert.equal(h.qrCalls.length, 1, '降级渲染二维码');
    assert.ok(h.tipText().includes('另一台设备'), '明确提示用另一台设备扫码');
  } finally {
    h.restore();
  }
});

test('弹窗结构：含「重新支付」按钮且初始 hidden', async () => {
  const h = loadPay({ ua: UA_MOBILE, respond: () => null });
  try {
    const html = h.modalHtml();
    assert.match(html, /id="pay-retry"\s+hidden/, 'pay-retry 缺失或未初始 hidden');
    assert.ok(html.includes('重新支付'), '按钮文案');
    assert.match(html, /id="pay-title"/, '标题节点可被按环境改写');
  } finally {
    h.restore();
  }
});
