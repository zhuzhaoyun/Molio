import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspaceService } from './navigation.ts'

export function registerMolioComposer(ctx: Context, workspaces: IWorkspaces, sessions: ISessions, uiWorkspace: UiWorkspaceService) {
  const molioComposer = (globalThis as {
    molioKnowledgeComposer?: { listen(callback: (draft: { path: string; prompt: string }) => Promise<void>): () => void }
  }).molioKnowledgeComposer
  if (molioComposer) ctx.effect(() => {
    const receive = (event: Event) => {
      const { sessionId, prompt } = (event as CustomEvent<{ sessionId: Parameters<ISessions['binding']>[0]; prompt: string }>).detail
      const binding = sessions.binding(sessionId)
      const conversation = ctx.get('conversation')
      if (binding && conversation && conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' }) !== 'blocked') event.preventDefault()
    }
    window.addEventListener('molio:session-draft', receive)
    return () => window.removeEventListener('molio:session-draft', receive)
  })
  if (molioComposer) ctx.effect(() => molioComposer.listen(async ({ path, prompt }) => {
    const workspace = workspaces.list.getSnapshot().items.find(item => item.path === path)
      ?? await workspaces.create({ path })
    await uiWorkspace.openWorkspace(workspace.workspaceId, id => {
      const binding = sessions.binding(id)
      const conversation = ctx.get('conversation')
      if (!binding || !conversation || conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' }) === 'blocked') {
        throw new Error('当前会话无法接收知识库草稿')
      }
    })
  }))
}
