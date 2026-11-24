import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyMac } from './harness-mac.mjs'

/**
 * Customize the unsigned Windows build in the isolated host. Keep upstream's
 * local package preparation, ASAR integrity checks and post-package smoke.
 */
export async function applyPackaging(hostRoot) {
  const scripts = join(hostRoot, 'apps/desktop/scripts')
  async function edit(file, changes) {
    const path = join(scripts, file)
    const original = await readFile(path, 'utf8')
    let text = original.replaceAll('\r\n', '\n')
    for (const [from, to, applied = to] of changes) {
      if (text.includes(applied)) continue
      if (!text.includes(from)) throw new Error(`Unexpected upstream packaging code in ${file}: ${from}`)
      text = text.replace(from, to)
    }
    const result = original.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text
    if (result !== original) await writeFile(path, result)
  }

  await edit('package-target.ts', [
    ["  await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local']",
      "  if (!invocation.unsigned || process.env.MOLIO_PACKAGE_BUILT !== '1') await execute(invocation.unsigned ? ['run', 'build', '--profile', 'local']"],
    ["const environment = target.platform === 'darwin' && invocation.unsigned",
      "const environment: NodeJS.ProcessEnv = invocation.unsigned && target.platform === 'win32'\n    ? { ...localMacOSPackageEnvironment(), DSH_DESKTOP_APP_ID: 'com.molio.harness', MOLIO_WINDOWS_PACKAGE: '1' }\n    : target.platform === 'darwin' && invocation.unsigned"],
  ])
  await edit('prepare-runtime.ts', [
    ["artifactName: 'electron', cacheRoot: BUILD_PATHS.downloads",
      "artifactName: 'electron', checksums: require('electron/checksums.json'), cacheRoot: BUILD_PATHS.downloads"],
  ])
  await edit('desktop-package-environment.mjs', [
    ["if (target.platform !== 'darwin' || !options.unsigned) resolveDesktopPolicyEnvironment(environment)",
      "if (!(options.unsigned && (target.platform === 'darwin' || environment.MOLIO_WINDOWS_PACKAGE === '1'))) resolveDesktopPolicyEnvironment(environment)"],
  ])
  await edit('desktop-toolchain-preflight.ts', [
    ["if (platform === 'win32') failures.push", "if (platform === 'win32' && environment.MOLIO_WINDOWS_PACKAGE !== '1') failures.push"],
  ])
  const protocolConfig = join(scripts, 'electron-builder-config.mjs')
  const previousProtocol = "protocols: molio ? [] : [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]"
  const withProtocols = "protocols: molio ? [{ name: 'Molio Harness', schemes: ['molio', 'dsh'] }] : [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]"
  const previousConfig = await readFile(protocolConfig, 'utf8')
  if (previousConfig.includes(previousProtocol)) {
    await writeFile(protocolConfig, previousConfig.replace(previousProtocol, withProtocols))
  }
  await edit('electron-builder-config.mjs', [
    ["const policy = packagesMacOS && unsigned ? undefined", "const molio = packagesWindows && unsigned && env.MOLIO_WINDOWS_PACKAGE === '1'\n  const policy = molio || (packagesMacOS && unsigned) ? undefined", "const policy = molio || (packagesMacOS && unsigned) ? undefined"],
    ["if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()", "if (packagesWindows && !molio) installWindowsDirectoryInstaller()"],
    ["productName: 'DeepSeek Harness',", "productName: molio ? 'Molio Harness' : 'DeepSeek Harness',"],
    ["artifactName: `deepseek-harness-", "artifactName: `${molio ? 'molio-harness' : 'deepseek-harness'}-"],
    ["protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }]", withProtocols],
    ["if (resolvedPlatform !== 'win32') return true", "if (molio || resolvedPlatform !== 'win32') return true"],
    ["nsis: {", "nsis: molio ? { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true } : {"],
  ])
  await edit('smoke-packaged-runtime.ts', [
    ["join(application, 'DeepSeek Harness.exe')",
      "join(application, process.env.MOLIO_WINDOWS_PACKAGE === '1' ? 'Molio Harness.exe' : 'DeepSeek Harness.exe')"],
  ])
  await applyMac(hostRoot)
}
