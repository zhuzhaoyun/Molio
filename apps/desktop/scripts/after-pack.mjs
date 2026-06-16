/**
 * electron-builder afterPack hook — unified entry point.
 *
 * Delegates to platform-specific hooks:
 *   - Windows: patches .exe metadata so protocol dialogs show "Molio"
 *   - macOS:     copies usage README into DMG root so users see Gatekeeper workaround
 */

import { join, dirname } from 'node:path';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @param {import('electron-builder').AfterPackContext} context */
export default async function (context) {
  const { appOutDir, packager, electronPlatformName } = context;

  if (electronPlatformName === 'darwin') {
    await copyMacOSReadme(appOutDir);
  }

  if (electronPlatformName === 'win32') {
    await fixWindowsExeMetadata(appOutDir, packager);
  }
}

/**
 * Copy macOS usage README into DMG root (alongside Molio.app).
 * Users opening the DMG will see this file immediately, explaining
 * how to bypass Gatekeeper's "damaged app" warning.
 */
async function copyMacOSReadme(appOutDir) {
  const src = join(__dirname, '..', 'build', 'macos-usage.txt');
  const dest = join(appOutDir, '使用前必读.txt');

  try {
    copyFileSync(src, dest);
    console.log('[after-pack] macOS: copied 使用前必读.txt to DMG root');
  } catch (err) {
    console.error(`[after-pack] macOS: failed to copy README: ${err.message}`);
    // Don't fail the build — README is cosmetic
  }
}

/**
 * Patch Windows .exe metadata so protocol association dialogs
 * show "Molio" instead of "Electron".
 */
async function fixWindowsExeMetadata(appOutDir, packager) {
  const { existsSync } = await import('node:fs');
  const { createRequire } = await import('node:module');

  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exePath = join(appOutDir, exeName);

  if (!existsSync(exePath)) {
    console.warn(`[after-pack] Windows: .exe not found at ${exePath}`);
    return;
  }

  console.log(`[after-pack] Windows: patching ${exePath}`);

  try {
    const require = createRequire(import.meta.url);
    const { rcedit } = require('rcedit');
    await rcedit(exePath, {
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
    console.log('[after-pack] Windows: done');
  } catch (err) {
    console.error(`[after-pack] Windows: failed: ${err.message}`);
  }
}
