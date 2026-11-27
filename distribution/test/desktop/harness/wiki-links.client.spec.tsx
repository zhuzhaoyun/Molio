// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { MarkdownDelegateProvider } from '../src/index.ts'
import { parseFileLink } from '../src/markdown/file-link.ts'

it('normalizes a slash-prefixed drive path before opening a preview', () => {
  expect(parseFileLink('/D:/wiki/%E7%AC%94%E8%AE%B0.md#L2')).toEqual({ path: 'D:/wiki/笔记.md', line: 2 })
  for (const path of ['/vault/file.md', '//server/share/file.md', 'D:/wiki/file.md']) {
    expect(parseFileLink(path)).toEqual({ path })
  }
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([true, false])('opens Chinese wiki references in the conversation vault (streaming=%s)', async streaming => {
  const openFile = vi.fn()
  const resolveWiki = vi.fn(async (_cwd: string, page: string) => ({ path: "/vault/" + page + ".md" }))
  vi.stubGlobal('molioNavigation', { resolveWiki })
  const text = '正文：[[八王之乱]]；[[wiki/entities/贾后|贾后]]，`[[代码]]`。\n\n```md\n[[示例]]\n```'
  render(<MarkdownDelegateProvider wikiCwd="/vault" openFile={openFile}><MarkdownText text={text} streaming={streaming}/></MarkdownDelegateProvider>)
  fireEvent.click(screen.getByRole('link', { name: '八王之乱' }))
  fireEvent.click(screen.getByRole('link', { name: '贾后' }))
  expect(resolveWiki.mock.calls).toEqual([['/vault', '八王之乱'], ['/vault', 'wiki/entities/贾后']])
  await vi.waitFor(() => expect(openFile.mock.calls).toEqual([["/vault/八王之乱.md"], ["/vault/wiki/entities/贾后.md"]]))
  expect(screen.queryAllByRole('link')).toHaveLength(2)
})
