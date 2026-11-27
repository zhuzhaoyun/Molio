import type { ReactNode } from 'react'
import { isScalar, isSeq } from 'yaml'
import { MolioWikiText } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render YAML string values and string lists containing Obsidian references. */
export function wikiFieldValue(node: unknown, original: string): ReactNode {
  if (!original.includes('[[')) return original
  if (isScalar(node) && typeof node.value === 'string') return <MolioWikiText text={original} />
  if (!isSeq(node)) return original

  const items: string[] = []
  for (const item of node.items) {
    if (!isScalar(item) || typeof item.value !== 'string') return original
    items.push(item.value)
  }
  if (!items.some(text => text.includes('[['))) return original
  return <ul style={{ margin: 0, paddingInlineStart: '1.3em' }}>
    {items.map((text, index) => <li key={index}><MolioWikiText text={text} /></li>)}
  </ul>
}
