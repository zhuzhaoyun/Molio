// apps/web/src/components/diagnostics/checkupActions.ts
// 体检面板的桌面动作分发：把体检报告里的 DiagnosticAction 映射到桌面桥
// （preload 注入的 window.__electron__ / window.updater）或应用内跳转。
import type { DiagnosticAction } from '@molio/contracts';

/**
 * 只声明体检用到的全局形状（全部可选）：打包后的渲染进程里由 preload 注入，
 * 浏览器 / Playwright 里不存在。不复用 electron.d.ts 的 DesktopAPI——它没有
 * restartApp 声明，且单测要用字面量对象当假 window，结构化窄化最省事。
 */
export interface BridgeWindow {
  __electron__?: {
    restartApp?: () => Promise<unknown>;
    openPath?: (p: string) => Promise<unknown>;
    getLogPath?: () => Promise<string | null>;
  };
  updater?: { checkForUpdates?: () => Promise<unknown> };
}

/** 从 window 里读出的桌面能力（缺的 方法=undefined）。 */
export interface DesktopBridge {
  restartApp?: () => Promise<unknown>;
  openPath?: (p: string) => Promise<unknown>;
  checkForUpdates?: () => Promise<unknown>;
  getLogPath?: () => Promise<string | null>;
}

/** 读出桌面桥；四个方法一个都没有 → null（浏览器环境）。 */
export function readDesktopBridge(win: BridgeWindow): DesktopBridge | null {
  const bridge: DesktopBridge = {
    restartApp: win.__electron__?.restartApp,
    openPath: win.__electron__?.openPath,
    getLogPath: win.__electron__?.getLogPath,
    checkForUpdates: win.updater?.checkForUpdates,
  };
  const hasAny = bridge.restartApp ?? bridge.openPath ?? bridge.getLogPath ?? bridge.checkForUpdates;
  return hasAny ? bridge : null;
}

/**
 * 动作能否执行：open-url 是应用内跳转（useNavigate），不依赖桌面壳，恒可执行；
 * 其余三个都是桌面动作，桥上没有对应方法就不渲染按钮（E2E 跑在纯浏览器里，
 * 正是靠这条让桌面专属按钮不出现）。
 */
export function canRunAction(action: DiagnosticAction, bridge: DesktopBridge | null): boolean {
  switch (action.code) {
    case 'open-url': return true;
    case 'restart-app': return !!bridge?.restartApp;
    case 'check-updates': return !!bridge?.checkForUpdates;
    case 'open-folder': return !!bridge?.openPath;
  }
}

/**
 * 执行动作。缺对应方法时静默跳过不抛错——按钮本就不该渲染（canRunAction），
 * 这里是兜底；非技术用户面前弹一个「无法执行」远不如没这个按钮。
 */
export function runDiagnosticAction(
  action: DiagnosticAction,
  bridge: DesktopBridge | null,
  onOpenUrl: (path: string) => void,
): void {
  switch (action.code) {
    case 'restart-app':
      bridge?.restartApp?.();
      break;
    case 'check-updates':
      bridge?.checkForUpdates?.();
      break;
    case 'open-folder':
      // open-folder 的 target 是绝对目录；缺失属契约违规，静默跳过
      if (action.target != null) bridge?.openPath?.(action.target);
      break;
    case 'open-url':
      if (action.target != null) onOpenUrl(action.target);
      break;
  }
}
