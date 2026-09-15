// pay.js 支付成功态「加入用户群」二维码测试（node:test）。
// 背景：付费交付时刻是加群转化最高点，支付成功后在弹窗内展示用户群二维码。
// 群二维码路径以 IIFE 求值期捕获的 SCRIPT_BASE 为基准解析（与 shared.js 同思路），
// 构建期一次性设好 src，成功回调只切 hidden —— 因此可用最小桩同步验证路径解析。
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAY_JS = readFileSync(path.join(here, '..', 'pay.js'), 'utf8');

/**
 * 以最小浏览器桩加载 pay.js，构建支付弹窗并返回群二维码解析结果与弹窗 HTML。
 * readyState='complete' → IIFE 末尾同步执行 buildModal()，弹窗与 groupQr.src 立即就绪。
 * 无真实 DOM：createElement 节点的 innerHTML setter 用正则把每个 id="..." 注册进
 * registry，getElementById 据此回查（pay.js 构建后按 id 取 pay-group-qr 等节点）。
 */
function loadPay({ scriptSrc, pathname = '/resources.html' }) {
  const registry = new Map();
  function makeNode(tag) {
    const node = {
      tag, id: '', hidden: false, src: '', href: '', textContent: '', className: '',
      style: {}, dataset: {}, children: [],
      _innerHTML: '',
      setAttribute() {}, addEventListener() {},
      appendChild(c) { node.children.push(c); return c; },
      querySelector() { return null; },
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._innerHTML; },
      set(html) {
        node._innerHTML = html;
        const re = /id="([^"]+)"/g;
        let m;
        while ((m = re.exec(html))) {
          if (!registry.has(m[1])) {
            const stub = makeNode('div');
            stub.id = m[1];
            registry.set(m[1], stub);
          }
        }
      },
    });
    return node;
  }
  const body = makeNode('body');
  globalThis.window = { addEventListener() {} };
  globalThis.location = { pathname, href: 'https://molio.cn' + pathname };
  globalThis.document = {
    readyState: 'complete',
    currentScript: scriptSrc === null ? null : { src: scriptSrc },
    createElement: makeNode,
    getElementById: (id) => registry.get(id) || null,
    addEventListener() {},
    body,
  };
  let out;
  try {
    new Function(PAY_JS)();
    const modal = body.children[0];
    const groupQr = registry.get('pay-group-qr');
    out = {
      modalHtml: modal ? modal.innerHTML : '',
      groupQrSrc: groupQr ? groupQr.src : null,
      hasGroupBlock: /id="pay-group"\s+hidden/.test(modal ? modal.innerHTML : ''),
      groupAlt: groupQr ? null : null, // alt 在字符串里断言
    };
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  }
  return out;
}

test('线上列表页（resources.html 加载 /pay.js）：群二维码解析到站点根 images/qrcode.png', () => {
  const { groupQrSrc } = loadPay({ scriptSrc: 'https://molio.cn/pay.js?v=20260823a' });
  assert.equal(groupQrSrc, 'https://molio.cn/images/qrcode.png');
});

test('SSR 商品页（/resource/xxx.html 加载 /pay.js）：SCRIPT_BASE 为根，仍指向站点根图片', () => {
  const { groupQrSrc } = loadPay({
    scriptSrc: 'https://molio.cn/pay.js?v=20260823a',
    pathname: '/resource/01M13QT669Q6E94PWACEH00YJF.html',
  });
  assert.equal(groupQrSrc, 'https://molio.cn/images/qrcode.png');
});

test('本地 file:// 预览：解析到脚本同目录的 images/qrcode.png（不裂图）', () => {
  const { groupQrSrc } = loadPay({
    scriptSrc: 'file:///D:/work/02-code/Molio/apps/landing-page/pay.js',
    pathname: '/D:/work/02-code/Molio/apps/landing-page/resources.html',
  });
  assert.equal(groupQrSrc, 'file:///D:/work/02-code/Molio/apps/landing-page/images/qrcode.png');
});

test('极老浏览器无 currentScript + 列表页：回退根绝对路径 /images/qrcode.png', () => {
  const { groupQrSrc } = loadPay({ scriptSrc: null, pathname: '/resources.html' });
  assert.equal(groupQrSrc, '/images/qrcode.png');
});

test('极老浏览器无 currentScript + SSR 商品页：回退上一级 ../images/qrcode.png', () => {
  const { groupQrSrc } = loadPay({
    scriptSrc: null,
    pathname: '/resource/01M13QT669Q6E94PWACEH00YJF.html',
  });
  assert.equal(groupQrSrc, '../images/qrcode.png');
});

test('弹窗结构：含 pay-group 块且初始 hidden，含群二维码 img 与加群文案', () => {
  const { modalHtml, hasGroupBlock } = loadPay({ scriptSrc: 'https://molio.cn/pay.js' });
  assert.ok(hasGroupBlock, 'pay-group 块缺失或未初始 hidden');
  assert.ok(modalHtml.includes('id="pay-group-qr"'), '缺少群二维码 <img>');
  assert.ok(modalHtml.includes('用户交流群二维码'), '群二维码缺少无障碍 alt');
  assert.ok(modalHtml.includes('扫码加入用户群'), '缺少加群引导文案');
});
