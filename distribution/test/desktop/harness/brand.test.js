import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('Molio branding applies twice to the pinned desktop and web host', async t => {
  const { applyBrand } = await import('../../../../scripts/harness-brand.mjs')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const upstream = join(root, 'vendor/deepseek-harness')
  if (!existsSync(join(upstream, 'apps/web/index.html'))) return t.skip('Initialize the Harness submodule to check pinned host branding')
  const host = await mkdtemp(join(tmpdir(), 'molio-brand-'))
  t.after(() => rm(host, { recursive: true, force: true }))
  const sidebar = 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx'
  const official = 'packages/client/ui-brand-official/src/client/Brand.tsx'
  const frame = 'packages/client/ui-layout/src/client/AppFrame.tsx'
  const plugin = 'packages/client/ui-brand-official/src/client/index.ts'
  for (const file of [sidebar, official, frame, plugin, 'apps/web/index.html', 'apps/web/public/manifest.webmanifest']) {
    await mkdir(dirname(join(host, file)), { recursive: true })
    await cp(join(upstream, file), join(host, file))
  }
  for (const directory of ['resources', 'renderer/assets']) {
    await mkdir(join(host, 'apps/desktop', directory), { recursive: true })
  }
  await applyBrand(host)
  const first = await readFile(join(host, sidebar), 'utf8')
  await applyBrand(host)
  assert.equal(await readFile(join(host, sidebar), 'utf8'), first)
  assert.match(first, /src="\/favicon.svg"/)
  assert.doesNotMatch(first, /FishLogo/)
  assert.match(await readFile(join(host, official), 'utf8'), /<span>Molio<\/span>/)
  assert.match(await readFile(join(host, frame), 'utf8'), /DSH_CLIENT_TITLE \?\? 'Molio'/)
  assert.doesNotMatch(await readFile(join(host, plugin), 'utf8'), /PixelWhale/)
  const manifest = JSON.parse(await readFile(join(host, 'apps/web/public/manifest.webmanifest')))
  assert.equal(manifest.short_name, 'Molio')
  for (const icon of manifest.icons) {
    const png = await readFile(join(host, 'apps/web/public', icon.src))
    assert.equal(png.readUInt32BE(16) + 'x' + png.readUInt32BE(20), icon.sizes)
  }
  assert.deepEqual(await readFile(join(host, 'apps/desktop/resources/icon-windows.png')),
    await readFile(join(root, 'distribution/brand/icon.png')))
})
