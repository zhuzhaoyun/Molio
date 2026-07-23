/**
 * Feishu wiki/docx 正文抓取器 — Electron main process 侧。
 *
 * 维护一个隐藏 BrowserWindow（feishu partition），加载 wiki/docx URL → 等 SPA
 * 渲染正文 → 在 renderer 里跑 `htmlToMarkdown` 抓 Markdown → 返回。
 *
 * 通过本机 HTTP server 暴露给 daemon：
 *   POST /fetch-wiki  { url }  →  { markdown, title, selector } | { markdown: null, reason }
 *
 * 设计要点：
 * - 同 partition 的 cookies 持久化到磁盘（用户在引导窗口登录一次，跨重启复用）。
 * - 串行处理（单用户场景），多个 URL 排队执行。
 * - LRU 缓存，TTL 30min。
 * - 登录墙早退：检测到 `/suite/passport/static/login/` 脚本或 URL 跳到 passport.feishu.cn
 *   时立即返回 `reason: 'login_required'`，不再继续等渲染。
 *
 * Electron APIs 用 dynamic `await import('electron')` 懒加载，避免测试环境（无 electron
 * 运行时）模块加载失败。`_internal` 里的脚本构造器是纯 JS，可在 Node 直接测。
 */

import http from 'node:http';
import { log } from './logger.js';
import { htmlToMarkdown } from './html-to-markdown.js';

const FETCH_HOST = '127.0.0.1';
const FETCH_TIMEOUT_MS = 30_000;
const RENDER_WAIT_MS = 15_000;
const RENDER_POLL_INTERVAL_MS = 500;
const MIN_CONTENT_LEN = 200;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 50;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 正文容器候选选择器，按优先级排序。第一个 innerText 长度超阈值的即命中。
// 实际命中在 log 里打印，便于后续收敛选择器列表。
const CONTENT_SELECTORS = [
  '.bear-web-x-container',
  '.render',
  '.docx-doc',
  '[data-page-id]',
  '.wiki-content',
  'main[role="main"]',
  'article',
];

const LOGIN_SCRIPT_HINT = '/suite/passport/static/login/';

let fetcherWindow = null;
let fetchQueue = Promise.resolve();
const cache = new Map();
let server = null;

async function ensureWindow() {
  const electron = await import('electron');
  const { BrowserWindow, session } = electron;
  if (fetcherWindow && !fetcherWindow.isDestroyed()) return fetcherWindow;
  const feishuSession = session.fromPartition('feishu', { cache: true });
  await feishuSession.webRequest.onBeforeSendHeaders((details, cb) => {
    // Force a real-browser UA so feishu's edge CDN doesn't 404 us (curl UA gets
    // blocked at the CDN edge before reaching the SPA shell).
    details.requestHeaders['User-Agent'] = USER_AGENT;
    cb({ requestHeaders: details.requestHeaders });
  });
  fetcherWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: feishuSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  fetcherWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return fetcherWindow;
}

/**
 * Build the in-renderer probe script. Returns the matched selector + content
 * length when the body has rendered meaningful text, or `{ login: true }` if
 * the load landed on a login wall, or `{ login: false, selector: null }` while
 * still waiting.
 */
function buildProbeScript() {
  return [
    '(function () {',
    '  if (location.href.indexOf("passport.feishu.cn") >= 0',
    '      || location.pathname.indexOf("/login") === 0) {',
    '    return { login: true };',
    '  }',
    '  var scripts = document.scripts;',
    '  for (var i = 0; i < scripts.length; i++) {',
    '    if (scripts[i].src && scripts[i].src.indexOf(' + JSON.stringify(LOGIN_SCRIPT_HINT) + ') >= 0) {',
    '      return { login: true };',
    '    }',
    '  }',
    '  var selectors = ' + JSON.stringify(CONTENT_SELECTORS) + ';',
    '  for (var i = 0; i < selectors.length; i++) {',
    '    var el = document.querySelector(selectors[i]);',
    '    if (el && el.innerText && el.innerText.length > ' + MIN_CONTENT_LEN + ') {',
    '      return { login: false, selector: selectors[i], len: el.innerText.length };',
    '    }',
    '  }',
    '  return { login: false, selector: null, len: document.body ? document.body.innerText.length : 0 };',
    '})();',
  ].join('\n');
}

function buildExtractScript(selector) {
  // Inject the walker's source into the renderer scope then call it. The
  // walker function is a named function expression, so its self-reference
  // resolves correctly even after .toString() + eval — recursion is preserved.
  //
  // The fn() call is wrapped in try/catch INSIDE the page: if the walker throws
  // on some exotic DOM node, executeJavaScript only surfaces a useless
  // "Script failed to execute… check the renderer console" wrapper, and the
  // window is hidden so that console is unreachable. Catching in-page lets us
  // return the real error + stack so doFetch can log the actual cause.
  return [
    '(function () {',
    '  var fn = ' + htmlToMarkdown.toString() + ';',
    '  var container = document.querySelector(' + JSON.stringify(selector) + ') || document.body;',
    '  try {',
    '    return { markdown: fn(container), title: document.title || "" };',
    '  } catch (e) {',
    '    return { markdown: null, extractError: (e && (e.stack || e.message)) || String(e) };',
    '  }',
    '})();',
  ].join('\n');
}

async function doFetch(url) {
  const win = await ensureWindow();
  await win.webContents.loadURL(url, { userAgent: USER_AGENT });

  const deadline = Date.now() + RENDER_WAIT_MS;
  let matched = null;
  let contentLen = 0;
  while (Date.now() < deadline) {
    const probe = await win.webContents.executeJavaScript(buildProbeScript(), true);
    if (probe && probe.login) {
      log('info', 'wiki-fetcher', url + ' → login_required (login wall / tenant not logged in)');
      return { markdown: null, reason: 'login_required' };
    }
    if (probe && probe.selector) {
      matched = probe.selector;
      contentLen = probe.len;
      break;
    }
    await new Promise((r) => setTimeout(r, RENDER_POLL_INTERVAL_MS));
  }

  if (!matched) {
    // Log the FINAL URL too: a blank body (bodyLen=0) often means the load
    // silently redirected to a login / no-permission page the probe didn't
    // flag — finalUrl reveals that instead of leaving us guessing.
    let finalUrl = '';
    try { finalUrl = win.webContents.getURL(); } catch { finalUrl = ''; }
    log('info', 'wiki-fetcher', url + ' → render_timeout (no content selector matched in ' + RENDER_WAIT_MS + 'ms, bodyLen=' + contentLen + ', finalUrl=' + finalUrl + ')');
    return { markdown: null, reason: 'render_timeout', contentLen, finalUrl };
  }

  let extraction;
  try {
    extraction = await win.webContents.executeJavaScript(buildExtractScript(matched), true);
  } catch (err) {
    const errMsg = err && err.message || String(err);
    log('error', 'wiki-fetcher', url + ' → extract_failed (selector=' + matched + '): ' + errMsg);
    return { markdown: null, reason: 'extract_failed', error: errMsg };
  }

  // The in-page try/catch (buildExtractScript) turns a thrown walker into a
  // returned extractError carrying the REAL stack. Log it verbatim — this is
  // the line that reveals which DOM shape breaks the converter.
  if (extraction && extraction.extractError) {
    log('error', 'wiki-fetcher', url + ' → extract_failed (selector=' + matched + '): ' + extraction.extractError);
    return { markdown: null, reason: 'extract_failed', error: extraction.extractError };
  }

  const markdown = (extraction && extraction.markdown || '').trim();
  if (!markdown) {
    log('info', 'wiki-fetcher', url + ' → extract_empty (selector=' + matched + ' matched but markdown empty)');
    return { markdown: null, reason: 'extract_empty', selector: matched };
  }

  log('info', 'wiki-fetcher', 'extracted ' + markdown.length + ' chars from ' + url + ' via selector=' + matched);
  return { markdown, title: extraction.title || '', selector: matched };
}

export async function fetchWiki(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { markdown: cached.markdown, title: cached.title, cached: true };
  }
  // Serialize: the hidden window is single-instance; concurrent loads would
  // race on its webContents.
  const result = await new Promise((resolve) => {
    fetchQueue = fetchQueue.then(async () => {
      try {
        resolve(await doFetch(url));
      } catch (err) {
        const errMsg = err && err.message || String(err);
        log('error', 'wiki-fetcher', url + ' → fetch_error: ' + errMsg);
        resolve({ markdown: null, reason: 'fetch_error', error: errMsg });
      }
    });
  });
  if (result.markdown) {
    cache.set(url, { markdown: result.markdown, title: result.title, fetchedAt: Date.now() });
    if (cache.size > CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }
  return result;
}

function handleRequest(req, res) {
  if (req.method !== 'POST' || req.url !== '/fetch-wiki') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }
  let buf = '';
  req.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1024 * 1024) {
      res.writeHead(413);
      res.end('Payload Too Large');
      req.destroy();
    }
  });
  req.on('end', async () => {
    let payload;
    try {
      payload = JSON.parse(buf || '{}');
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json: ' + (err && err.message || err) }));
      return;
    }
    const url = payload && payload.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid url' }));
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log('error', 'wiki-fetcher', url + ' → fetch_timeout (no response in ' + (FETCH_TIMEOUT_MS + 5000) + 'ms)');
      if (!res.writableEnded) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markdown: null, reason: 'fetch_timeout' }));
      }
    }, FETCH_TIMEOUT_MS + 5000);
    try {
      const result = await fetchWiki(url);
      if (timedOut) return;
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) return;
      log('error', 'wiki-fetcher', 'fetch failed: ' + (err && err.message || err));
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err && err.message || String(err) }));
      }
    }
  });
}

/**
 * Start the local HTTP server on a random port bound to 127.0.0.1.
 * Returns the port number; main.js passes it to the daemon via env.
 */
export function startFetchServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);
    server.on('error', (err) => {
      log('error', 'wiki-fetcher', 'http server error: ' + (err && err.message || err));
      reject(err);
    });
    server.listen(0, FETCH_HOST, () => {
      const port = server.address().port;
      log('info', 'wiki-fetcher', 'http server listening on ' + FETCH_HOST + ':' + port);
      resolve(port);
    });
  });
}

export async function stopFetchServer() {
  if (fetcherWindow && !fetcherWindow.isDestroyed()) {
    try { fetcherWindow.destroy(); } catch {}
    fetcherWindow = null;
  }
  await new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => { server = null; resolve(); });
  });
}

// Exposed for tests (no Electron dependency in the builders themselves).
export const _internal = {
  buildProbeScript,
  buildExtractScript,
  CONTENT_SELECTORS,
  CACHE_TTL_MS,
  MIN_CONTENT_LEN,
};
