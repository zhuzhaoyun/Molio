import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { useMarkdownDelegate } from './MarkdownDelegate.tsx'

/** Resolve Wiki references in document text and YAML property values. */
export function MolioWikiText({ text, inlineCode = false }: { text: string; inlineCode?: boolean }) {
  const { wikiCwd, openFile, wikiInlineCode } = useMarkdownDelegate()
  const bridge = (globalThis as { molioNavigation?: {
    resolveWiki(cwd: string, page: string): Promise<string | { path: string }>
  } }).molioNavigation
  if (!wikiCwd || !bridge || !openFile || (inlineCode && !wikiInlineCode)) {
    return inlineCode ? <code>{text}</code> : <>{text}</>
  }
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of text.matchAll(/(?<!!)\[\[([^\[\]|\r\n]+)(?:\|([^\[\]\r\n]*))?\]\]/gu)) {
    const target = match[1]!.trim()
    const page = target.split('#')[0]!.trim()
    if (!page) continue
    parts.push(text.slice(offset, match.index))
    parts.push(<a key={match.index} href={'#' + encodeURIComponent(target)} title={target}
      onClick={async event => {
        event.preventDefault()
        const result = await bridge.resolveWiki(wikiCwd, page).catch(() => '无法连接知识库')
        if (typeof result === 'string') window.alert(result)
        else openFile(result.path)
      }}>{match[2]?.trim() || target}</a>)
    offset = match.index + match[0].length
  }
  return <Fragment>{parts}{text.slice(offset)}</Fragment>
}
