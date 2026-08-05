/**
 * 引导用户登录飞书账号 — 用 feishu partition 开可见 BrowserWindow。
 *
 * 同 partition 跟 wiki-fetcher.js 共用 → cookies 持久化到磁盘，登录一次跨重启复用。
 * 用户可能在多个租户（geekbang.feishu.cn、open.feishu.cn、自家租户）有访问需求，
 * 默认打开 `https://feishu.cn`，用户自行切换到目标租户登录。
 *
 * 登录成功后自动关闭：仅当「本次开窗真正走过登录页 → 现已离开登录页 → 有会话 cookie」
 * 才自动关（shouldAutoCloseLogin）。若开窗时已有旧登录态（从没见过登录页），窗口保持
 * 打开，让用户从容导航到目标租户登录——避免「已登录就秒关、没机会换租户」的坑。
 * 真正走完登录（连续 ~2s 判定已登出登录页）后标题显示「登录成功」并自动关窗。
 */

import { log } from './logger.js';

const DEFAULT_LOGIN_URL = 'https://feishu.cn/';
const LOGIN_WINDOW_WIDTH = 1200;
const LOGIN_WINDOW_HEIGHT = 800;
const LOGIN_DETECT_INTERVAL_MS = 1000;
const LOGIN_DETECT_STREAK = 2; // 连续 N 次判定已登录才确认，避开跳转抖动
const LOGIN_SUCCESS_CLOSE_DELAY_MS = 1200;

/** 飞书登录态会话 cookie 名（用于登录状态展示，见 getFeishuLoginStatus）。 */
const FEISHU_SESSION_COOKIE_NAMES = new Set([
  'sid_tt', 'ssid_tt', 'sid_tt_ss', 'ssid_tt_ss', 'uid_tt', 'sid_guard', 'session',
]);

let loginWindow = null;
let loginDetectTimer = null;
let loginDetectStreak = 0;
/** 本次开窗是否见过登录页。只有见过登录页后又登出，才算「真正完成一次登录」可自动关窗；
 *  开窗时已有旧登录态（没见过登录页）则保持打开，让用户导航到目标租户登录。 */
let sawLoginPage = false;

/** URL 是否正停在登录页（passport.* 或 /login 路径）。 */
function onLoginPage(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  const host = u.hostname.toLowerCase();
  if (host === 'passport.feishu.cn' || host.startsWith('passport.')) return true;
  if (u.pathname.startsWith('/login')) return true;
  return false;
}

/**
 * 是否该自动关窗（纯函数，供测试）。仅当「本次开窗走过登录页（sawLoginPage）→
 * 现已离开登录页（!onLoginNow）→ 有会话 cookie（loggedIn）」三者同时成立才关。
 *
 * 关键：开窗时已有旧 cookie 但从没见过登录页（sawLoginPage=false）→ 返回 false，
 * 窗口保持打开，让用户导航到目标租户登录。这修掉了「已登录就秒关、没法换租户」的 bug。
 */
function shouldAutoCloseLogin({ sawLoginPage, onLoginNow, loggedIn }) {
  return sawLoginPage && !onLoginNow && loggedIn;
}

export function openFeishuLogin(targetUrl) {
  // Lazy-load Electron so this module can be imported in non-Electron contexts
  // (e.g., tests). Inside an actual Electron runtime the import is cached.
  import('electron').then(({ BrowserWindow, session }) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      return;
    }
    const feishuSession = session.fromPartition('feishu', { cache: true });
    loginWindow = new BrowserWindow({
      width: LOGIN_WINDOW_WIDTH,
      height: LOGIN_WINDOW_HEIGHT,
      title: '登录飞书账号 — Molio',
      show: true,
      webPreferences: {
        session: feishuSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    loginWindow.on('closed', () => {
      stopLoginDetection();
      loginWindow = null;
    });
    // Block popups — feishu may try to open new windows for OAuth / external links.
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      loginWindow.webContents.loadURL(url);
      return { action: 'deny' };
    });
    const url = typeof targetUrl === 'string' && /^https?:\/\//.test(targetUrl)
      ? targetUrl
      : DEFAULT_LOGIN_URL;
    log('info', 'wiki-fetcher-login', 'opening feishu login window at ' + url);
    loginWindow.loadURL(url);
    startLoginDetection(loginWindow);
  }).catch((err) => {
    log('error', 'wiki-fetcher-login', 'failed to load electron: ' + (err && err.message || err));
  });
}

function stopLoginDetection() {
  if (loginDetectTimer) {
    clearInterval(loginDetectTimer);
    loginDetectTimer = null;
  }
  loginDetectStreak = 0;
}

function startLoginDetection(win) {
  stopLoginDetection();
  sawLoginPage = false; // 每个新窗口重新计时：没见过登录页就不算「完成登录」，不自动关
  loginDetectTimer = setInterval(async () => {
    if (win.isDestroyed()) { stopLoginDetection(); return; }
    let url = '';
    try { url = win.webContents.getURL(); } catch { url = ''; }
    const onLoginNow = onLoginPage(url);
    if (onLoginNow) sawLoginPage = true;
    let loggedIn = false;
    try { loggedIn = (await getFeishuLoginStatus()).loggedIn; } catch { loggedIn = false; }
    if (win.isDestroyed()) { stopLoginDetection(); return; }
    const done = shouldAutoCloseLogin({ sawLoginPage, onLoginNow, loggedIn });
    if (done) {
      loginDetectStreak += 1;
      if (loginDetectStreak >= LOGIN_DETECT_STREAK) {
        stopLoginDetection();
        onLoginSuccess(win, url);
      }
    } else {
      loginDetectStreak = 0;
    }
  }, LOGIN_DETECT_INTERVAL_MS);
}

function onLoginSuccess(win, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  log('info', 'wiki-fetcher-login', 'login success detected (' + (host || url) + ') — closing window');
  if (win.isDestroyed()) return;
  win.setTitle('登录成功 — Molio');
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, LOGIN_SUCCESS_CLOSE_DELAY_MS);
}

/**
 * 读取 feishu partition 的会话 cookie，判断是否已登录飞书账号（供面板展示 + 自动关窗判定）。
 * 基于 cookie 而非内存事件 → 跨重启依然准确（cookie 持久化在磁盘）。命中任一 feishu/
 * larksuite 域上的会话 cookie 即视为已登录。需求只关心「登没登录」，不再区分具体租户。
 */
export function getFeishuLoginStatus() {
  return import('electron').then(async ({ session }) => {
    const feishuSession = session.fromPartition('feishu', { cache: true });
    let cookies = [];
    try { cookies = await feishuSession.cookies.get({}); } catch { cookies = []; }
    let loggedIn = false;
    for (const c of cookies) {
      if (!c.value || !FEISHU_SESSION_COOKIE_NAMES.has(c.name)) continue;
      const dom = (c.domain || '').replace(/^\./, '').toLowerCase();
      if (/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/.test(dom)) { loggedIn = true; break; }
    }
    return { loggedIn };
  }).catch(() => ({ loggedIn: false }));
}

export function closeFeishuLogin() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }
}

// Exposed for tests (pure logic, no Electron dependency).
export const _internal = {
  onLoginPage,
  shouldAutoCloseLogin,
  FEISHU_SESSION_COOKIE_NAMES,
};
