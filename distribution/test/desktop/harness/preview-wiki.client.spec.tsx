// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MolioMarkdownBody } from '../src/client/markdown/MolioMarkdownBody.tsx'
import { zh } from '../src/client/markdown/locales.ts'
import type { MarkdownBodyProps } from '../src/client/markdown/MarkdownBody.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens a wiki reference in the previewed document vault and leaves inline code literal', async () => {
  const file = 'D:/资料/wiki/sources/增长.md'
  const target = 'D:/资料/wiki/entities/曼行.md'
  const resolveWiki = vi.fn(async () => ({ path: target }))
  const openResource = vi.fn()
  vi.stubGlobal('molioNavigation', { resolveWiki })
  const text = '这是 [[曼行]] 的分享。另见 [[曼行|作者]]。`[[示例]]`'
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
})
