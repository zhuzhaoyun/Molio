/**
 * 「在文件夹中显示」——把知识库产出文件定位到系统文件管理器（Electron 桌面端专属）。
 *
 * 底层是桌面壳 preload 暴露的 window.__electron__.showItemInFolder
 * （IPC → shell.showItemInFolder，见 apps/desktop/src/preload.cjs / main.js），
 * 纯浏览器（dev / E2E / NAS 远程访问）下不存在该 API——isRevealAvailable()
 * 返回 false，调用方据此不渲染入口（同 KbMainContent 的 isElectron 守卫模式）。
 *
 * 路径归一与 utils/workSteps.ts 的 writeKey 同一语义（反斜杠统一、剥 ./ 前缀、
 * 剥 vault 前缀）的反向操作：agent 对 Write 工具的上报形态不稳定（同文件可能先报
 * 相对后报绝对），拼绝对路径前必须先归一，否则会产生 `/vault//Users/...` 二次前缀。
 */

interface ElectronRevealBridge {
  showItemInFolder?: unknown;
}

function revealBridge(): { showItemInFolder: (p: string) => Promise<void> } | null {
  const bridge = (globalThis as { window?: { __electron__?: ElectronRevealBridge } })
    .window?.__electron__;
  if (typeof bridge?.showItemInFolder !== 'function') return null;
  return { showItemInFolder: bridge.showItemInFolder as (p: string) => Promise<void> };
}

/** 桌面壳是否注入了 reveal 能力（纯浏览器返回 false）。 */
export function isRevealAvailable(): boolean {
  return revealBridge() !== null;
}

/**
 * 把 agent 上报的路径归一为 vault 内绝对路径。
 * 已是 vault 内绝对路径的（POSIX 或 Windows 形态）原样返回（反斜杠归一为正斜杠，
 * shell.showItemInFolder 在 Windows 下接受正斜杠——与树右键既有拼法一致）。
 */
export function toAbsoluteVaultPath(vaultPath: string, rawPath: string): string {
  const vp = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let p = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (p === vp || p.startsWith(`${vp}/`)) return p;
  return `${vp}/${p}`;
}

/**
 * 在系统文件管理器中显示该文件并选中。不可用时返回 false（不抛错）；
 * showItemInFolder 的拒绝（文件已被移动/删除）吞掉并 warn——定位失败不值得打断用户。
 */
export function revealInFolder(vaultPath: string, rawPath: string): boolean {
  const bridge = revealBridge();
  if (!bridge) return false;
  bridge.showItemInFolder(toAbsoluteVaultPath(vaultPath, rawPath)).catch((err: unknown) => {
    console.warn('[reveal] showItemInFolder failed:', err);
  });
  return true;
}
