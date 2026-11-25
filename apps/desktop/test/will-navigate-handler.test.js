/**
 * Regression test — clicking a plain <a href="https://…"> inside the app
 * (rendered KB/chat markdown without target=_blank) navigated the Electron
 * window itself to the external site, leaving the user stranded outside
 * Molio with the knowledge base unusable.
 *
 * 判定逻辑抽在 src/navigation-policy.js（纯函数），这里直接喂 URL 验证分类；
 * 另加一条接线检查，确保 main.js 的 will-navigate 处理器真的用上了它。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideNavigation, shouldClearReadiness } from '../src/navigation-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf-8');

const APP_ORIGINS = new Set(['http://localhost:3100', 'http://localhost:5173']);

describe('decideNavigation（导航放行策略）', () => {
  it('外部 http(s) 交给系统浏览器', () => {
    assert.equal(decideNavigation('https://www.anthropic.com/store', APP_ORIGINS), 'external');
    assert.equal(decideNavigation('http://127.0.0.1:9999/x', APP_ORIGINS), 'external');
    // URL 解析会规范化协议大小写
    assert.equal(decideNavigation('HTTPS://example.com/a', APP_ORIGINS), 'external');
  });

  it('应用自身 origin（daemon / vite dev）原地导航', () => {
    assert.equal(decideNavigation('http://localhost:3100/knowledge?vault=v1', APP_ORIGINS), 'allow');
    assert.equal(decideNavigation('http://localhost:5173/settings', APP_ORIGINS), 'allow');
    // 端口不同即不同 origin
    assert.equal(decideNavigation('http://localhost:3101/knowledge', APP_ORIGINS), 'external');
  });

  it('本地文件（错误页）原地导航', () => {
    assert.equal(decideNavigation('file:///C:/molio/error.html', APP_ORIGINS), 'allow');
  });

  it('mailto / tel 交给系统邮件客户端与电话应用', () => {
    assert.equal(decideNavigation('mailto:hi@example.com', APP_ORIGINS), 'external');
    assert.equal(decideNavigation('tel:operator', APP_ORIGINS), 'external');
  });

  it('危险或未知协议只拦截，不交给 OS', () => {
    assert.equal(decideNavigation('javascript:alert(1)', APP_ORIGINS), 'block');
    assert.equal(decideNavigation('data:text/html,<h1>x</h1>', APP_ORIGINS), 'block');
    assert.equal(decideNavigation('molio://open/vault/v1/file/a.md', APP_ORIGINS), 'block');
  });

  it('无法解析的 URL 一律 block', () => {
    assert.equal(decideNavigation('not a url', APP_ORIGINS), 'block');
    assert.equal(decideNavigation('', APP_ORIGINS), 'block');
  });
});

describe('shouldClearReadiness（取消的导航不清 readiness）', () => {
  it('会被放行的主框架跨文档导航才清（应用 origin / file:）', () => {
    assert.equal(
      shouldClearReadiness(
        { url: 'http://localhost:3100/knowledge', isMainFrame: true, isSameDocument: false },
        APP_ORIGINS,
      ),
      true,
    );
    assert.equal(
      shouldClearReadiness(
        { url: 'file:///C:/molio/error.html', isMainFrame: true, isSameDocument: false },
        APP_ORIGINS,
      ),
      true,
    );
  });

  it('外链导航会被 will-navigate 取消，不得清 readiness', () => {
    // 事件顺序 did-start-navigation → will-navigate；后者 cancel 后文档还在，
    // 清了就永远恢复不了，后续剪藏全部退化为整页重载。
    assert.equal(
      shouldClearReadiness(
        { url: 'https://example.com/', isMainFrame: true, isSameDocument: false },
        APP_ORIGINS,
      ),
      false,
    );
    assert.equal(
      shouldClearReadiness(
        { url: 'mailto:hi@example.com', isMainFrame: true, isSameDocument: false },
        APP_ORIGINS,
      ),
      false,
    );
  });

  it('同文档与子框架导航不清 readiness', () => {
    assert.equal(
      shouldClearReadiness(
        { url: 'http://localhost:3100/knowledge?vault=v1', isMainFrame: true, isSameDocument: true },
        APP_ORIGINS,
      ),
      false,
    );
    assert.equal(
      shouldClearReadiness(
        { url: 'https://example.com/frame', isMainFrame: false, isSameDocument: false },
        APP_ORIGINS,
      ),
      false,
    );
    assert.equal(shouldClearReadiness(undefined, APP_ORIGINS), false);
  });
});

describe('main.js will-navigate 接线', () => {
  it('注册 will-navigate 并调用 decideNavigation(APP_ORIGINS)', () => {
    assert.ok(mainSource.includes("on('will-navigate'"), '必须注册 will-navigate 处理器');
    assert.match(
      mainSource,
      /decideNavigation\(targetUrl,\s*APP_ORIGINS\)/,
      'will-navigate 必须使用 navigation-policy 的判定结果',
    );
  });

  it('非 allow 的导航先 preventDefault，再按 external 交给系统', () => {
    const body = mainSource.match(
      /will-navigate',\s*\(event,\s*targetUrl\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/,
    )?.[1];
    assert.ok(body, 'will-navigate 处理器体必须可提取');
    const preventAt = body.indexOf('event.preventDefault()');
    const openAt = body.indexOf('shell.openExternal(targetUrl)');
    assert.ok(preventAt >= 0, '必须调用 event.preventDefault() 阻止原地导航');
    assert.ok(openAt >= 0, 'external 分支必须调用 shell.openExternal');
    assert.ok(preventAt < openAt, '必须先阻止导航，再交给系统浏览器');
  });

  it('did-start-navigation 清 readiness 前先过 shouldClearReadiness', () => {
    const body = mainSource.match(
      /did-start-navigation',\s*\(details\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/,
    )?.[1];
    assert.ok(body, 'did-start-navigation 处理器体必须可提取');
    assert.match(body, /shouldClearReadiness\(details,\s*APP_ORIGINS\)/);
    assert.ok(
      body.indexOf('shouldClearReadiness') < body.indexOf('onNavigationStarted'),
      '必须先判定再清 readiness',
    );
  });

  it('APP_ORIGINS 由 daemon origin 与 vite dev origin 组成', () => {
    // createWindow 的 body 禁止直接引用 DAEMON_BASE（test/daemon-startup.test.js），
    // 所以允许列表放在模块作用域。
    assert.match(
      mainSource,
      /APP_ORIGINS\s*=\s*new Set\(\[DAEMON_BASE,\s*'http:\/\/localhost:5173'\]\)/,
      'APP_ORIGINS 必须包含 daemon 与 vite dev origin',
    );
  });
});
