import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { isAbsoluteWorkspacePath, pathPartsOf, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { MarkdownBody, type MarkdownBodyProps } from './MarkdownBody.tsx'

export function MolioMarkdownBody(props: MarkdownBodyProps) {
  if (!('molioNavigation' in globalThis)) return <MarkdownBody {...props} />
  return <VaultDocument {...props} />
}

function VaultDocument(props: MarkdownBodyProps) {
  const file = props.useResource<'file'>(props.resourceAddress).value?.absolutePath
  const { tab } = props.useTabInfo()
  const openFile = (path: string) => {
    const target = file && !isAbsoluteWorkspacePath(path) ? pathPartsOf(file).directory + path : path
    tab.actions.openResource(sessionFileAddress(props.sessionId, target))
  }
  return <MarkdownDelegateProvider wikiCwd={file} openFile={openFile}>
    <MarkdownBody {...props} />
  </MarkdownDelegateProvider>
}
