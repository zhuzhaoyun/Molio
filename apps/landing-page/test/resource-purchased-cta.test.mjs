// resource-hydrate.js「已购识别」测试（node:test）。
//
// 背景（用户报障）：付完款关掉页面，那个 1 小时签名的下载链就找不回来了；重新打开商品页，
// CTA 还是「微信支付 ¥49」（云端 SSR 只按商品价格生成，不感知用户），用户以为要再付一次 ——
// 真点下去会再建一笔合法订单、真的重复扣款。
//
// 修复：已登录时查一次云端已购，命中且商品在架 → 主按钮换成「下载」
//（云端 /market/listings/:id/download 对已购放行，故无需后端改动）。
//
// 无真实 DOM/网络：桩 document/window/fetch/MolioAuth，用 setImmediate 驱动 promise 链。
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const HYDRATE_JS = readFileSync(path.join(here, '..', 'resource-hydrate.js'), 'utf8');

const LISTING_ID = '01M13QT669Q6E94PWACEH00YJF';
const SIGNED_URL = 'https://molio-pay.oss-cn-guangzhou.aliyuncs.com/resources/x-vault.zip?Signature=s';

async function flushAll() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/**
 * 加载 resource-hydrate.js 的浏览器桩。
 * @param {object} [opts]
 * @param {boolean} [opts.loggedIn]  MolioAuth.isLoggedIn()
 * @param {object}  [opts.listing]   window.__LISTING__（SSR 内嵌）
 * @param {(url:string)=>({status:number, body:object}|null)} [opts.respond]
 */
function loadHydrate(opts = {}) {
  const {
    loggedIn = true,
    listing = { id: LISTING_ID, priceCents: 4900 },
    respond = () => null,
  } = opts;

  const fetchCalls = [];
  const opened = [];
  const docListeners = new Map();
  let swapped = null;   // markPurchased() 置换出来的新按钮

  function makeEl(tag) {
    const listeners = new Map();
    const el = {
      tag, id: '', className: '', textContent: '', disabled: false, children: [],
      parentNode: null, _listeners: listeners,
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) { const l = listeners.get(type) || []; l.push(fn); listeners.set(type, l); },
      appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
      querySelector() { return null; },
      replaceChild(newNode, oldNode) {
        const i = el.children.indexOf(oldNode);
        if (i >= 0) el.children[i] = newNode; else el.children.push(newNode);
        newNode.parentNode = el;
        swapped = newNode;
        return oldNode;
      },
      click() { for (const fn of listeners.get('click') || []) fn({ target: el }); },
    };
    return el;
  }

  // 主按钮 + 它的父容器（置换发生在父子之间）+ 侧栏说明节点
  const payBtn = makeEl('button');
  payBtn.id = 'pay-btn';
  payBtn.className = 'btn btn-primary';
  const priceYuan = listing && listing.priceCents ? listing.priceCents / 100 : 0;
  payBtn.textContent = `微信支付 ¥${priceYuan}`;
  const card = makeEl('div');
  card.className = 'res-side-card';
  card.appendChild(payBtn);
  const note = makeEl('p');
  note.className = 'res-side-note';
  note.textContent = '扫码支付成功后自动解锁下载，下载链接 1 小时内有效。';
  card.appendChild(note);

  const byId = new Map([['pay-btn', payBtn]]);
  const document = {
    readyState: 'complete',
    createElement: makeEl,
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '.res-side-card .res-side-note' ? note : null),
    addEventListener(type, fn) { const l = docListeners.get(type) || []; l.push(fn); docListeners.set(type, l); },
  };

  const MolioAuth = {
    isLoggedIn: () => loggedIn,
    refreshLabels() {},
    requireAuth: () => Promise.resolve({ id: 'u1' }),
    getAccessToken: () => Promise.resolve('test-token'),
  };

  const window = {
    __LISTING__: listing,
    MolioAuth,
    MolioPay: { open() {} },
    open(url) { opened.push(url); },
    addEventListener() {},
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const u = String(url);
    fetchCalls.push(u);
    const r = respond(u);
    if (!r) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: r.status === 200, status: r.status, json: async () => r.body });
  };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { pathname: `/resource/${LISTING_ID}.html` };

  new Function(HYDRATE_JS)();

  return {
    payBtn,
    note,
    fetchCalls,
    opened,
    purchasesCalls: () => fetchCalls.filter((u) => u.includes('/market/purchases')),
    downloadCalls: () => fetchCalls.filter((u) => u.includes('/download')),
    /** 置换后的按钮（未置换则为 null） */
    swapped: () => swapped,
    swappedText: () => (swapped ? swapped.textContent : payBtn.textContent),
    flushAll,
    restore() {
      globalThis.fetch = realFetch;
      delete globalThis.window;
      delete globalThis.document;
      delete globalThis.location;
    },
  };
}

/** `/market/purchases` 返回指定条目 */
const purchasesRespond = (items, status = 200) => (url) => {
  if (url.includes('/market/purchases')) return { status, body: { purchases: items } };
  if (url.includes('/download')) return { status: 200, body: { url: SIGNED_URL, expiresAt: 0 } };
  return null;
};

test('已购 + 在架：主按钮换成「已购 · 下载资源包」，不再出现「微信支付」', async () => {
  const h = loadHydrate({
    loggedIn: true,
    respond: purchasesRespond([{ id: LISTING_ID, purchasedAt: '2026-10-01T00:00:00Z', available: true }]),
  });
  try {
    assert.equal(h.purchasesCalls().length, 0, '置换前不发探测');
    await flushAll();

    assert.equal(h.purchasesCalls().length, 1, '已登录才探测一次云端已购');
    assert.ok(h.purchasesCalls()[0].endsWith('/market/purchases'));
    assert.ok(h.swapped(), '主按钮已被置换');
    assert.equal(h.swappedText(), '已购 · 下载资源包');
    assert.ok(!h.swappedText().includes('微信支付'), '不再显示付费入口');
    assert.ok(h.note.textContent.includes('已购买'), '侧栏说明同步改写，避免「还要再付」的错觉');
  } finally {
    h.restore();
  }
});

test('已购态点击：直接取签名下载链，绝不重新下单', async () => {
  const h = loadHydrate({
    loggedIn: true,
    respond: purchasesRespond([{ id: LISTING_ID, available: true }]),
  });
  try {
    await flushAll();
    assert.ok(h.swapped());
    h.swapped().click();
    await flushAll();

    assert.equal(h.downloadCalls().length, 1, '走 /market/listings/:id/download');
    assert.ok(h.downloadCalls()[0].includes(`/market/listings/${LISTING_ID}/download`));
    assert.deepEqual(h.opened, [SIGNED_URL], '打开签名链接');
    assert.equal(h.fetchCalls.filter((u) => u.includes('/pay?')).length, 0, '没有再次下单（不可能重复扣款）');
    assert.equal(h.swappedText(), '已购 · 下载资源包', '成功后文案复位');
  } finally {
    h.restore();
  }
});

test('未登录：不探测，保持「微信支付」（免得把付费入口藏掉）', async () => {
  const h = loadHydrate({ loggedIn: false, respond: purchasesRespond([{ id: LISTING_ID, available: true }]) });
  try {
    await flushAll();
    assert.equal(h.fetchCalls.length, 0, '未登录不发任何请求');
    assert.equal(h.swapped(), null, '按钮未被置换');
    assert.equal(h.swappedText(), '微信支付 ¥49');
  } finally {
    h.restore();
  }
});

test('探测失败（云端 502 / 网络）：静默保持原按钮，用户仍能购买', async () => {
  const h = loadHydrate({ loggedIn: true, respond: () => ({ status: 502, body: { error: 'pay_unreachable' } }) });
  try {
    await flushAll();
    assert.equal(h.swapped(), null, '探测失败不置换');
    assert.equal(h.swappedText(), '微信支付 ¥49');
    h.payBtn.click();
    assert.equal(h.swapped(), null, '付费按钮仍可用（MolioPay.open 被调用）');
  } finally {
    h.restore();
  }
});

test('请求抛错（网络中断）：同样静默保持原按钮', async () => {
  const h = loadHydrate({ loggedIn: true, respond: null }); // respond 返回 null → 404
  try {
    await flushAll();
    assert.equal(h.swapped(), null);
    assert.equal(h.swappedText(), '微信支付 ¥49');
  } finally {
    h.restore();
  }
});

test('已购列表里没有本商品：保持「微信支付」', async () => {
  const h = loadHydrate({ loggedIn: true, respond: purchasesRespond([{ id: 'other-listing', available: true }]) });
  try {
    await flushAll();
    assert.equal(h.purchasesCalls().length, 1, '探测发出去了');
    assert.equal(h.swapped(), null, '未命中不置换');
    assert.equal(h.swappedText(), '微信支付 ¥49');
  } finally {
    h.restore();
  }
});

test('已购但商品已下架（available:false）：不置换，避免点了 404', async () => {
  const h = loadHydrate({ loggedIn: true, respond: purchasesRespond([{ id: LISTING_ID, available: false }]) });
  try {
    await flushAll();
    assert.equal(h.swapped(), null);
    assert.equal(h.swappedText(), '微信支付 ¥49');
  } finally {
    h.restore();
  }
});

test('已购态但取链失败：给可重试文案，不静默死按钮', async () => {
  const h = loadHydrate({
    loggedIn: true,
    respond: (url) => {
      if (url.includes('/market/purchases')) return { status: 200, body: { purchases: [{ id: LISTING_ID, available: true }] } };
      return { status: 502, body: { error: 'cloud_unreachable' } };
    },
  });
  try {
    await flushAll();
    assert.ok(h.swapped());
    h.swapped().click();
    await flushAll();
    assert.equal(h.opened.length, 0, '没打开任何链接');
    assert.equal(h.swappedText(), '下载失败，点击重试', '明确反馈，用户可再点');
    assert.equal(h.swapped().disabled, false, '按钮重新可点');
  } finally {
    h.restore();
  }
});

test('无 __LISTING__（异常页）：整层不绑定，不抛错', () => {
  const h = loadHydrate({ listing: null });
  try {
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.swapped(), null);
  } finally {
    h.restore();
  }
});