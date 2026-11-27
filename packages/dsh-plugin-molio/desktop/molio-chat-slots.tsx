import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { apply as installChat } from './apply.ts'
import { MolioTargetControls } from './chat/MolioTarget.tsx'
import { MolioPreviewLocation } from './MolioPreviewLocation.tsx'

function SessionTarget({ sessionId, useSessions }: PropsRuntime<'conversation.input.dock'>) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  return <MolioTargetControls key={sessionId} sessionId={sessionId} cwd={cwd} />
}

function PreviewAction({ absolutePath }: PropsRuntime<'sidebar.right.tab.document.actions'>) {
  return <MolioPreviewLocation path={absolutePath} />
}

export function apply(ctx: Context): void {
  installChat(ctx)
  if (!('molioNavigation' in globalThis)) return
  ctx.inject(['commandUi'], ctx => {
    ctx.effect(() => ctx.commandUi.register({
      name: 'molio-ingest', label: () => '文件入库', available: () => true,
      ui: { kind: 'action', run: ({ sessionId }) => {
        window.dispatchEvent(new CustomEvent('molio:show-ingest', { detail: sessionId }))
      } },
    }))
  })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'molio-target',
  }, SessionTarget))
  ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'molio-open-in-vault',
  }, PreviewAction))
}
