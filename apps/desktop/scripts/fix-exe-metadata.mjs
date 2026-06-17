/**
 * electron-builder afterPack hook — fixes Electron exe metadata so Windows
 * protocol association dialogs show "Molio" instead of "Electron".
 *
 * Called by electron-builder after the app is packaged but before signing.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** @param {import('electron-builder').AfterPackContext} context */
export default async function (context) {
  const { appOutDir, packager } = context;
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
    console.log('[fix-exe-metadata] Done — Windows protocol dialog will show "Molio"');
  } catch (err) {
    console.error(`[fix-exe-metadata] Failed: ${err.message}`);
    // Don't fail the build — metadata is cosmetic
  }
}