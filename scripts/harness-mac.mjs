import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Apply unsigned preinstall metadata in the disposable, pinned desktop source. */
export async function applyMac(hostRoot) {
  const scripts = join(hostRoot, 'apps/desktop/scripts')
  const edits = {
    'package-target.ts': [
      ['? localMacOSPackageEnvironment()', "? { ...localMacOSPackageEnvironment(), DSH_DESKTOP_APP_ID: 'com.molio.harness', MOLIO_MAC_PACKAGE: '1' }"],
      ['const filename = `deepseek-harness-', "const filename = `${environment.MOLIO_MAC_PACKAGE === '1' && invocation.unsigned ? 'molio-harness' : 'deepseek-harness'}-"],
    ],
    'electron-builder-config.mjs': [
      ["const molio = packagesWindows && unsigned && env.MOLIO_WINDOWS_PACKAGE === '1'",
        "const molioMac = packagesMacOS && unsigned && env.MOLIO_MAC_PACKAGE === '1'\n  const molio = molioMac || (packagesWindows && unsigned && env.MOLIO_WINDOWS_PACKAGE === '1')"],
      ["NSMicrophoneUsageDescription: 'DeepSeek Harness uses your microphone",
        "NSMicrophoneUsageDescription: molioMac ? 'Molio Harness uses your microphone to transcribe speech into message drafts.' : 'DeepSeek Harness uses your microphone"],
    ],
    'smoke-packaged-runtime.ts': [
      ['const artifacts = desktopArtifactOutput', "const macProduct = values.unsigned && process.env.MOLIO_MAC_PACKAGE === '1' ? 'Molio Harness' : 'DeepSeek Harness'\nconst artifacts = desktopArtifactOutput"],
      ["'DeepSeek Harness.app', 'Contents'", "`${macProduct}.app`, 'Contents'"],
      ["'MacOS', 'DeepSeek Harness'", "'MacOS', macProduct"],
    ],
  }

  for (const [file, changes] of Object.entries(edits)) {
    const path = join(scripts, file)
    const original = await readFile(path, 'utf8')
    let source = original.replaceAll('\r\n', '\n')
    for (const [from, to] of changes) {
      if (source.includes(to)) continue
      if (!source.includes(from)) throw new Error(`Unexpected upstream macOS packaging code in ${file}: ${from}`)
      source = source.replace(from, to)
    }
    const result = original.includes('\r\n') ? source.replaceAll('\n', '\r\n') : source
    if (result !== original) await writeFile(path, result)
  }
}
