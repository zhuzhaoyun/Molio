// shared.js 悬浮二维码路径解析测试（node:test）。
// 背景：默认二维码曾固定根绝对路径 '/images/qrcode.png'，本地 file:// 预览时
// 解析到盘符根目录导致裂图。修复后以 document.currentScript.src 为基准解析。
// 运行：node --test apps/landing-page/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_JS = readFileSync(path.join(here, '..', 'shared.js'), 'utf8');

/**
 * 以最小浏览器桩加载 shared.js 并返回注入的悬浮层节点。
 * readyState='complete' → IIFE 末尾同步执行 run()，appendChild 即可捕获注入结果。
 */
function loadShared({ scriptSrc, pathname = '/index.html', dataset = {} }) {
  const appended = [];
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    innerHeight: 800,
    addEventListener: () => {},
  };
  globalThis.location = { pathname, href: 'https://molio.cn' + pathname };
  globalThis.document = {
    readyState: 'complete',
    currentScript: scriptSrc === null ? null : { src: scriptSrc },
    getElementById: () => null,
    createElement: () => ({ innerHTML: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: {
      dataset,
      insertBefore: () => {},
      appendChild: (n) => appended.push(n),
    },
  };
  try {
    new Function(SHARED_JS)();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  }
  const floaters = appended.find((n) => n.innerHTML && n.innerHTML.includes('float-qr'));
  assert.ok(floaters, '未注入悬浮二维码节点');
  const m = floaters.innerHTML.match(/<img src="([^"]+)"/);
  assert.ok(m, '悬浮层里没有 <img>');
  return m[1];
}

test('file:// 本地预览：二维码解析到脚本同目录的 images/（用户报告的裂图场景）', () => {
  const src = loadShared({
    scriptSrc: 'file:///D:/work/02-code/Molio/apps/landing-page/shared.js?v=20260904',
    pathname: '/D:/work/02-code/Molio/apps/landing-page/index.html',
  });
  assert.equal(src, 'file:///D:/work/02-code/Molio/apps/landing-page/images/qrcode.png');
});

test('线上根页面：解析到站点根 /images/qrcode.png（与修复前行为一致）', () => {
  const src = loadShared({ scriptSrc: 'https://molio.cn/shared.js?v=20260813a' });
  assert.equal(src, 'https://molio.cn/images/qrcode.png');
});

test('SSR 商品页（/resource/xxx.html 加载 /shared.js）：仍指向站点根图片', () => {
  const src = loadShared({
    scriptSrc: 'https://molio.cn/shared.js?v=20260813a',
    pathname: '/resource/01M131Y1182Z2D4BYFH8KV1GCN.html',
  });
  assert.equal(src, 'https://molio.cn/images/qrcode.png');
});

test('blog 子目录页（../shared.js 解析后脚本仍在根）：指向站点根图片', () => {
  const src = loadShared({
    scriptSrc: 'https://molio.cn/shared.js?v=20260731',
    pathname: '/blog/local-knowledge-base.html',
  });
  assert.equal(src, 'https://molio.cn/images/qrcode.png');
});

test('自定义 data-float-qr（enterprise.html 的 images/yaol.jpg）：按同一基准解析', () => {
  const src = loadShared({
    scriptSrc: 'https://molio.cn/shared.js?v=20260731',
    dataset: { floatQr: 'images/yaol.jpg', floatCaption: '聊聊' },
  });
  assert.equal(src, 'https://molio.cn/images/yaol.jpg');
});

test('极老浏览器无 document.currentScript：回退旧逻辑（根绝对路径仍可用）', () => {
  const src = loadShared({ scriptSrc: null });
  assert.equal(src, '/images/qrcode.png');
});
