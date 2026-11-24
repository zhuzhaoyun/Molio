// apps/web/src/components/diagnostics/checkupActions.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  readDesktopBridge, canRunAction, runDiagnosticAction,
  type BridgeWindow, type DesktopBridge,
} from './checkupActions.ts';

/**
 * 体检面板的桌面动作分发。全部用字面量对象当假 window / 假桥，
 * 不碰真实 DOM——浏览器里（单测环境）本来就没有桌面桥。
 */
describe('checkupActions', () => {
  it('readDesktopBridge: 没有桌面桥返回 null，有则取出各方法', () => {
    const empty: BridgeWindow = {};
    assert.equal(readDesktopBridge(empty), null);
    // 真实 preload 形状：restartApp/openPath 在 __electron__，checkForUpdates/getLogPath 在 updater
    const b = readDesktopBridge({
      __electron__: { restartApp: async () => {} },
      updater: { checkForUpdates: async () => {}, getLogPath: async () => null },
    });
    assert.equal(typeof b?.restartApp, 'function');
    assert.equal(typeof b?.checkForUpdates, 'function');
    assert.equal(typeof b?.getLogPath, 'function');
    assert.equal(b?.openPath, undefined);
  });

  it('readDesktopBridge: getLogPath 只认 updater 桥（preload 在 updaterAPI 里暴露）', () => {
    // 回归钉子：getLogPath 曾被从 __electron__ 读——preload 从没在那里暴露过，
    // 「打开日志文件夹」按钮在真实应用里永远渲染不出来
    const b = readDesktopBridge({ updater: { getLogPath: async () => '/logs/updater.log' } });
    assert.equal(typeof b?.getLogPath, 'function');
    // __electron__ 上没有 getLogPath：只装了 restartApp 时它必须是 undefined
    const noUpdater = readDesktopBridge({ __electron__: { restartApp: async () => {} } });
    assert.equal(noUpdater?.getLogPath, undefined);
  });

  it('canRunAction: 应用内跳转恒可执行，桌面动作要有对应方法', () => {
    assert.equal(canRunAction({ code: 'open-url', label: 'x' }, null), true);
    assert.equal(canRunAction({ code: 'restart-app', label: 'x' }, null), false);
    assert.equal(canRunAction({ code: 'restart-app', label: 'x' }, { restartApp: async () => {} }), true);
    assert.equal(canRunAction({ code: 'check-updates', label: 'x' }, null), false);
    assert.equal(canRunAction({ code: 'open-folder', label: 'x' }, null), false);
  });

  it('runDiagnosticAction: 重启 / 检查更新 / 打开文件夹 / 应用内跳转 各调各的', () => {
    const calls = { restartApp: 0, checkForUpdates: 0, openPath: 0, openUrl: 0 };
    let openedPath = '';
    let openedUrl = '';
    const bridge: DesktopBridge = {
      restartApp: async () => { calls.restartApp++; },
      checkForUpdates: async () => { calls.checkForUpdates++; },
      openPath: async (p: string) => { calls.openPath++; openedPath = p; },
    };
    const onOpenUrl = (p: string) => { calls.openUrl++; openedUrl = p; };

    runDiagnosticAction({ code: 'restart-app', label: 'r' }, bridge, onOpenUrl);
    runDiagnosticAction({ code: 'check-updates', label: 'c' }, bridge, onOpenUrl);
    runDiagnosticAction({ code: 'open-folder', label: 'o', target: 'D:\\molio\\logs' }, bridge, onOpenUrl);
    runDiagnosticAction({ code: 'open-url', label: 'u', target: '/settings?tab=runtimes' }, bridge, onOpenUrl);

    assert.deepEqual(calls, { restartApp: 1, checkForUpdates: 1, openPath: 1, openUrl: 1 });
    assert.equal(openedPath, 'D:\\molio\\logs');
    assert.equal(openedUrl, '/settings?tab=runtimes');
  });

  it('runDiagnosticAction: 缺少对应方法时静默跳过，不抛错', () => {
    assert.doesNotThrow(() => runDiagnosticAction({ code: 'restart-app', label: 'x' }, null, () => {}));
    assert.doesNotThrow(() => runDiagnosticAction({ code: 'open-url', label: 'x' }, null, () => {}));
  });
});
