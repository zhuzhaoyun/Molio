// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MolioMarkdownBody } from '../src/client/markdown/MolioMarkdownBody.tsx'
import { zh } from '../src/client/markdown/locales.ts'
import type { MarkdownBodyProps } from '../src/client/markdown/MarkdownBody.tsx'

// A running desktop can still expose the previous version of the shared UI.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  MolioWikiText: undefined,
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens a wiki reference in the previewed document vault and leaves inline code literal', async () => {
  const file = 'D:/资料/wiki/sources/增长.md'
  const target = 'D:/资料/wiki/entities/曼行.md'
  const resolveWiki = vi.fn(async () => ({ path: target }))
  const openResource = vi.fn()
  vi.stubGlobal('molioNavigation', { resolveWiki })
  const text = [
    '---', 'title: Y Combinator 谈如何拿到前 100 个客户', 'created: 2026-11-26',
    'tags:', '  - 营销/增长', 'related:', '  - "[[早期销售]]"', '  - "[[Y-Combinator|YC]]"',
    'author: "[[Zach Coelius]]"', 'sources:', '  - "两张截图，经 docling OCR"', '---',
    '这是 [[曼行]] 的分享。另见 [[曼行|作者]]。`[[示例]]`',
  ].join('\n')
  const props = {
    sessionId: 'session', resourceAddress: sessionFileAddress('session', file),
    content: { kind: 'text', text, pages: [], eof: true }, wrap: false, t: makeTranslate(zh),
    useResource: () => ({ value: { absolutePath: file } }),
    useTabInfo: () => ({ tab: { actions: { openResource } } }),
  } as unknown as MarkdownBodyProps
  render(<MolioMarkdownBody {...props} />)
  fireEvent.click(screen.getByRole('link', { name: '曼行' }))
  expect(resolveWiki).toHaveBeenCalledWith(file, '曼行')
  await waitFor(() => expect(openResource).toHaveBeenCalledWith(sessionFileAddress('session', target)))
  expect(screen.getByRole('link', { name: '作者' })).toBeDefined()
  expect(screen.getByText('[[示例]]').tagName).toBe('CODE')
  const related = await screen.findByRole('link', { name: '早期销售' })
  expect(related.closest('dd')?.textContent).toBe('早期销售YC')
  fireEvent.click(screen.getByRole('link', { name: 'YC' }))
  expect(resolveWiki).toHaveBeenCalledWith(file, 'Y-Combinator')
  expect(screen.getByRole('link', { name: 'Zach Coelius' })).toBeDefined()
  expect(screen.getByText('2026-11-26')).toBeDefined()
  expect(screen.getByText(/两张截图，经 docling OCR/)).toBeDefined()
})
