/**
 * electron-builder afterPack hook — fixes Electron exe metadata so Windows
 * protocol association dialogs show "Molio" instead of "Electron", and
 * ad-hoc signs the macOS .app so ShipIt code signature validation passes.
 *
 * Called by electron-builder after the app is packaged but before signing.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** @param {import('electron-builder').AfterPackContext} context */
export default async function (context) {
  const { appOutDir, packager } = context;

  // ── macOS: ad-hoc sign all binaries to satisfy ShipIt validation ──
  if (context.electronPlatformName === 'darwin') {
    const appName = `${packager.appInfo.productFilename}.app`;
    const appPath = join(appOutDir, appName);

    if (!existsSync(appPath)) {
      console.warn(`[fix-exe-metadata] App bundle not found: ${appPath}`);
      return;
    }

    console.log(`[fix-exe-metadata] Ad-hoc signing: ${appPath}`);
    try {
      execSync(
        `codesign --sign - --deep --force "${appPath}"`,
        { stdio: 'inherit' }
      );
      console.log('[fix-exe-metadata] Ad-hoc signing done');
    } catch (err) {
      console.error(`[fix-exe-metadata] Ad-hoc signing failed: ${err.message}`);
      // Don't fail the build — the packaging step may succeed anyway
    }
    return;
  }

  // ── Windows: patch exe metadata for protocol dialog ──
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exePath = join(appOutDir, exeName);

  if (!existsSync(exePath)) {
    console.warn(`[fix-exe-metadata] Exe not found: ${exePath}`);
    return;
  }

  console.log(`[fix-exe-metadata] Patching: ${exePath}`);

  try {
    const require = createRequire(import.meta.url);
    const { rcedit } = require('rcedit');
    // signAndEditExecutable:false 会让 electron-builder 跳过 exe 图标嵌入，
    // 必须用 rcedit 显式写入 Molio 的 .ico，否则任务栏/快捷方式显示 Electron 默认图标。
    const icoPath = join(import.meta.dirname, '..', 'build', 'icon.ico');
    await rcedit(exePath, {
      icon: icoPath,
      versionString: {
        FileDescription: 'Molio',
        ProductName: 'Molio',
        CompanyName: 'Molio Team',
        InternalName: 'Molio',
        OriginalFilename: 'Molio.exe',
      },
      fileVersion: packager.appInfo.version,
      productVersion: packager.appInfo.version,
    });
    console.log('[fix-exe-metadata] Done — Windows protocol dialog will show "Molio"');
  } catch (err) {
    console.error(`[fix-exe-metadata] Failed: ${err.message}`);
    // Don't fail the build — metadata is cosmetic
  }
}