import type { Context } from '@deepseek-ai/cordis'
import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconFolderOpenOutlineRegular, IconBranchOutlineRegular, IconAppsAddOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SidebarRoot.module.css'

const modules = [
  ['knowledge', '知识库', IconFolderOpenOutlineRegular],
  ['graph', '知识图谱', IconBranchOutlineRegular],
  ['resources', '资源市场', IconAppsAddOutlineRegular],
] as const

export const molioPanelId = 'molio-knowledge' as MainPanelId
export const bridge = (globalThis as { molioNavigation?: {
  open(id: string): void
  listen(callback: (url: string) => void): () => void
} }).molioNavigation

let currentUrl = ''
const listeners = new Set<() => void>()
const subscribe = (callback: () => void) => {
  listeners.add(callback)
  return () => { listeners.delete(callback) }
}
const useUrl = () => useSyncExternalStore(subscribe, () => currentUrl)
export function showMolioPage(url: string) {
  currentUrl = url
  for (const callback of listeners) callback()
}

export function MolioPanel() {
  const url = useUrl()
  const [initialUrl] = useState(url)
  const view = useRef<(HTMLElement & { getURL(): string; send(channel: string, route: string): void }) | null>(null)
  const ready = useRef(false)
  useEffect(() => {
    const guest = view.current
    if (!guest) return
    const sync = () => {
      if (ready.current && guest.getURL() !== currentUrl) guest.send('molio:clip-route', currentUrl)
    }
    const loaded = () => { ready.current = true; sync() }
    guest.addEventListener('dom-ready', loaded)
    const unsubscribe = subscribe(sync)
    return () => {
      unsubscribe()
      guest.removeEventListener('dom-ready', loaded)
    }
  }, [])
  return initialUrl ? createElement('webview', { ref: view, src: initialUrl, partition: 'persist:molio-knowledge',
    allowpopups: 'true', 'data-testid': 'molio-content', style: { flex: 1, width: '100%', height: '100%', minHeight: 0 } }) : null
}

export function MolioSidebar({ wide, selected }: { wide: boolean; selected: boolean }) {
  const url = useUrl()
  const page = url ? new URL(url) : undefined
  const active = page?.pathname === '/knowledge' ? (page.searchParams.get('panel') === 'graph' ? 'graph' : 'knowledge') : 'resources'
  if (!bridge) return null
  return <nav className={css.panelList} aria-label="知识管理">
    {modules.map(([id, label, Icon]) => <Tooltip key={id} label={label} disabled={wide} side="right">
      <button type="button" className={[css.panelRow, selected && active === id && css.panelEntryActive].filter(Boolean).join(' ')} data-testid={'molio-sidebar-' + id}
        aria-current={selected && active === id ? 'page' : undefined} aria-label={label} onClick={() => bridge?.open(id)}>
        <span className={css.panelGlyph} aria-hidden="true"><Icon size={wide ? 16 : 18} /></span>
        {wide && <span className={css.panelTitle}>{label}</span>}
      </button>
    </Tooltip>)}
  </nav>
}

export function registerMolioPanel(ctx: Context) {
  const navigation = bridge
  if (navigation) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: molioPanelId }, MolioPanel))
    ctx.effect(() => navigation.listen(url => {
      showMolioPage(url)
      ctx.layout.selectPanel(molioPanelId)
    }))
  }
}
