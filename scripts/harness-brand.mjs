import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const source = new URL('../distribution/brand/', import.meta.url)
const variants = new URL('./harness-icons/', import.meta.url)
const sidebar = 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx'
const official = 'packages/client/ui-brand-official/src/client/Brand.tsx'

/** Apply the Molio artwork to a disposable checkout before building the host. */
export async function applyBrand(hostRoot) {
  const path = name => join(hostRoot, name)
  async function replace(file, original, branded) {
    const value = await readFile(path(file), 'utf8')
    if (value.includes(original)) {
      await writeFile(path(file), value.replaceAll(original, branded))
    } else if (!value.includes(branded)) {
      throw new Error(`Unrecognized host branding in ${file}: ${original}`)
    }
  }

  const mark = (await readFile(new URL('mark.png', variants))).toString('base64')
  const svgImage = `<image width="64" height="64" href="data:image/png;base64,${mark}" />`
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${svgImage}</svg>\n`
  for (const file of ['favicon.svg', 'favicon-dark.svg']) {
    await writeFile(path('apps/web/public/' + file), favicon)
  }
  for (const file of ['apple-touch-icon.png', 'icon-192.png', 'icon-maskable-512.png']) {
    await copyFile(new URL(file, variants), path('apps/web/public/' + file))
  }
  for (const file of ['apps/web/public/icon-512.png', ...['icon.png', 'icon-windows.png', 'icon-macos.png']
    .map(name => 'apps/desktop/resources/' + name)]) {
    await copyFile(new URL('icon.png', source), path(file))
  }
  await copyFile(new URL('icon.ico', source), path('apps/desktop/resources/tray-windows.ico'))
  await writeFile(path('apps/desktop/renderer/assets/welcome-brand.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 224 64">${svgImage}<text x="76" y="49" font-family="sans-serif" font-weight="600" font-size="48" fill="#576175">Molio</text></svg>\n`)

  const markElement = size => `<img alt="" width={${size}} height={${size}} src="/favicon.svg" />`
  await replace(sidebar, 'FishLogo, IconAppsAddOutlineRegular', 'IconAppsAddOutlineRegular')
  await replace(sidebar, '<FishLogo size={24} />', markElement(24))
  await replace(sidebar, "{t('brand.localBuild')}", 'Molio')
  await replace(official, "import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'", '')
  await replace(official, '<FishLogo size={size} />', markElement('size'))
  await replace(official, '<BrandWordmark includeMark={false} />', '<span>Molio</span>')
  // The named local build strips inherited DSH_CLIENT_TITLE values.
  await replace('packages/client/ui-layout/src/client/AppFrame.tsx',
    "process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')", "process.env.DSH_CLIENT_TITLE ?? 'Molio'")
  await replace('packages/client/ui-layout/src/client/AppFrame.tsx', '  t,', '')
  const brandDirectory = 'packages/client/ui-brand-official/src/client/'
  await replace(brandDirectory + 'index.ts', "import { PixelWhale } from './home-whale/PixelWhale.tsx'",
    "import { MolioHomeFrame } from './MolioHomeFrame.tsx'")
  await replace(brandDirectory + 'index.ts', "id: 'pixel-whale'", "id: 'molio-home-mark'")
  await replace(brandDirectory + 'index.ts', '}, PixelWhale))', '}, MolioHomeFrame))')
  await writeFile(path(brandDirectory + 'MolioHomeFrame.tsx'), `import type { ReactNode } from 'react'
import type { HeroFrameOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

export function MolioHomeFrame({ hero, children }: HeroFrameOwnerProps & { children: ReactNode }) {
  return <>
    {hero && <img src="/favicon.svg" alt="" aria-hidden="true" width={64} height={64}
      style={{ position: 'absolute', right: '8%', bottom: '12%', opacity: 0.18, pointerEvents: 'none', zIndex: -1 }} />}
    {children}
  </>
}
`)
  await replace('apps/web/index.html', '<title>DSH Local Build</title>', '<title>Molio</title>')
  await replace('apps/web/index.html', 'content="DSH"', 'content="Molio"')
  const manifestFile = path('apps/web/public/manifest.webmanifest')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  await writeFile(manifestFile, JSON.stringify({ ...manifest, name: 'Molio', short_name: 'Molio' }, null, 2) + '\n')
}
