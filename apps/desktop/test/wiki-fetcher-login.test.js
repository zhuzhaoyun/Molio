import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/wiki-fetcher-login.js';

const { onLoginPage, shouldAutoCloseLogin } = _internal;

describe('onLoginPage — login-page detection (drives auto-close)', () => {
  it('flags the passport login domain', () => {
    assert.ok(onLoginPage('https://passport.feishu.cn/suite/passport/login'));
    assert.ok(onLoginPage('https://passport.feishu.cn/'));
  });

  it('flags any /login path', () => {
    assert.ok(onLoginPage('https://geekbang.feishu.cn/login'));
    assert.ok(onLoginPage('https://geekbang.feishu.cn/login?redirect=/messenger'));
  });

  it('does NOT flag post-login / tenant / marketing pages', () => {
    assert.ok(!onLoginPage('https://geekbang.feishu.cn/messenger'));
    assert.ok(!onLoginPage('https://www.feishu.cn/'));
    assert.ok(!onLoginPage('https://feishu.cn/'));
    assert.ok(!onLoginPage('https://acme.larksuite.com/docs'));
  });

  it('treats unparseable URLs as on-login (conservative: do not auto-close)', () => {
    assert.ok(onLoginPage('not a url'));
    assert.ok(onLoginPage(''));
  });
});

describe('shouldAutoCloseLogin — auto-close gating (fixes 已登录就秒关)', () => {
  it('stays open when already logged in but never saw a login page (the regression)', () => {
    // 开窗时已有旧 cookie（loggedIn=true）但从没见过登录页 → 绝不能秒关，
    // 否则用户没机会导航到目标租户登录。这正是本次修复的 bug。
    assert.equal(
      shouldAutoCloseLogin({ sawLoginPage: false, onLoginNow: false, loggedIn: true }),
      false,
    );
  });

  it('closes after a genuine login (saw login page → left it → has cookie)', () => {
    assert.equal(
      shouldAutoCloseLogin({ sawLoginPage: true, onLoginNow: false, loggedIn: true }),
      true,
    );
  });

  it('does not close while still on the login page', () => {
    assert.equal(
      shouldAutoCloseLogin({ sawLoginPage: true, onLoginNow: true, loggedIn: false }),
      false,
    );
  });

  it('does not close before any login page or cookie', () => {
    assert.equal(
      shouldAutoCloseLogin({ sawLoginPage: false, onLoginNow: true, loggedIn: false }),
      false,
    );
  });

  it('does not close if cookie missing even after leaving the login page', () => {
    assert.equal(
      shouldAutoCloseLogin({ sawLoginPage: true, onLoginNow: false, loggedIn: false }),
      false,
    );
  });
});
