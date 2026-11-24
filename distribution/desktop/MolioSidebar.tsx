import { IconFolderOpenOutlineRegular, IconBranchOutlineRegular, IconAppsAddOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SidebarRoot.module.css'

const modules = [
  ['knowledge', '知识库', IconFolderOpenOutlineRegular],
  ['graph', '知识图谱', IconBranchOutlineRegular],
  ['resources', '资源市场', IconAppsAddOutlineRegular],
] as const

export function MolioSidebar({ wide }: { wide: boolean }) {
  const bridge = (globalThis as { molioNavigation?: { open(module: string): void } }).molioNavigation
  if (!bridge) return null
  return <nav className={css.panelList} aria-label="知识管理">
    {modules.map(([id, label, Icon]) => <Tooltip key={id} label={label} disabled={wide} side="right">
      <button type="button" className={css.panelRow} data-testid={'molio-sidebar-' + id}
        aria-label={label} onClick={() => bridge.open(id)}>
        <span className={css.panelGlyph} aria-hidden="true"><Icon size={wide ? 16 : 18} /></span>
        {wide && <span className={css.panelTitle}>{label}</span>}
      </button>
    </Tooltip>)}
  </nav>
}
