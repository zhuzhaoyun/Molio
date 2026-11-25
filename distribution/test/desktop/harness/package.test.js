import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { applyDesktop } from '../../../../scripts/harness-desktop.mjs'
import { applyPackaging } from '../../../../scripts/harness-package.mjs'

test('unsigned Molio desktop packaging uses platform-specific artifacts and smoke paths', async t => {
  const upstream = fileURLToPath(new URL('../../../../vendor/deepseek-harness/apps/desktop/scripts/', import.meta.url))
  if (!existsSync(join(upstream, 'package-target.ts'))) return t.skip('Initialize the Harness submodule for this integration test')
  const host = await mkdtemp(join(tmpdir(), 'molio-package-'))
  t.after(() => rm(host, { recursive: true, force: true }))
  const scripts = join(host, 'apps/desktop/scripts')
  await mkdir(scripts, { recursive: true })
  const files = ['package-target.ts', 'desktop-package-environment.mjs', 'desktop-toolchain-preflight.ts',
    'electron-builder-config.mjs', 'smoke-packaged-runtime.ts', 'prepare-runtime.ts']
  for (const file of files) await cp(join(upstream, file), join(scripts, file))
  const extra = ['apps/desktop/src/browser-guests.ts', 'packages/client/ui-sidebar/src/client/index.ts', 'apps/desktop/src/main.ts', 'apps/desktop/src/preload-app.ts', 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx', 'packages/client/ui-workspace/src/client/index.ts']
  const upstreamHost = fileURLToPath(new URL('../../../../vendor/deepseek-harness/', import.meta.url))
  extra.push('packages/client/ui-primitives/src/markdown/render.tsx',
    'packages/client/ui-primitives/src/markdown/MarkdownDelegate.tsx',
    'packages/client/ui-chat/src/client/chat/ChatView.tsx')
  await mkdir(join(host, 'packages/client/ui-primitives/tests'), { recursive: true })
  for (const name of extra) await cp(join(upstreamHost, name), join(host, name), { recursive: true })
  applyDesktop(host)
  await applyPackaging(host)
  // A Windows checkout may normalize line endings between packaging runs.
  for (const path of [...files.map(file => join(scripts, file)), ...extra.map(file => join(host, file))]) {
    await writeFile(path, (await readFile(path, 'utf8')).replace(/\r?\n/g, '\r\n'))
  }
  const read = file => readFile(join(scripts, file), 'utf8')
  const first = await Promise.all(files.map(read))
  const desktopInitial = await Promise.all(extra.map(file => readFile(join(host, file), 'utf8')))
  applyDesktop(host)
  await applyPackaging(host)
  assert.deepEqual(await Promise.all(extra.map(file => readFile(join(host, file), 'utf8'))), desktopInitial)
  assert.deepEqual(await Promise.all(files.map(read)), first)
  assert.match(await read('electron-builder-config.mjs'), /nsis: molio \? \{ oneClick: false/)
  assert.match(await read('smoke-packaged-runtime.ts'), /'Molio Harness\.exe'/)
  assert.match(await read('package-target.ts'), /DSH_DESKTOP_APP_ID: 'com\.molio\.harness'/)
  const config = await read('electron-builder-config.mjs')
  assert.ok(config.includes("schemes: ['molio', 'dsh']"))
  for (const destination of ['molio', 'molio-support']) assert.equal(config.split(`to: '${destination}'`).length - 1, 1)
  const target = await read('package-target.ts')
  assert.match(target, /DSH_DESKTOP_APP_ID: 'com\.molio\.harness', MOLIO_MAC_PACKAGE: '1'/)
  assert.match(target, /environment\.MOLIO_MAC_PACKAGE === '1' && invocation\.unsigned \? 'molio-harness'/)
  assert.match(config, /const molioMac = packagesMacOS && unsigned && env\.MOLIO_MAC_PACKAGE === '1'/)
  assert.match(config, /productName: molio \? 'Molio Harness'/)
  assert.match(config, /NSMicrophoneUsageDescription: molioMac \? 'Molio Harness/)
  const smoke = await read('smoke-packaged-runtime.ts')
  const paths = smoke.slice(smoke.indexOf('const windows ='), smoke.indexOf('const descriptor ='))
  for (const [arch, subdir] of [['arm64', 'mac-arm64'], ['x64', 'mac']]) {
    for (const unsigned of [false, true]) {
      const actual = runInNewContext(paths + '\nexecutable', {
        target: 'mac-' + arch, join: posix.join, paths: {}, values: { unsigned },
        desktopArtifactOutput: () => ({ directory: '/out' }),
        process: { env: { MOLIO_MAC_PACKAGE: '1' } },
      })
      const product = unsigned ? 'Molio Harness' : 'DeepSeek Harness'
      assert.equal(actual, '/out/' + subdir + '/' + product + '.app/Contents/MacOS/' + product)
    }
  }
})
