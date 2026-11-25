// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { MarkdownDelegateProvider } from '../src/index.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([true, false])('opens Chinese wiki references in the conversation vault (streaming=%s)', streaming => {
  const openWiki = vi.fn().mockResolvedValue(null)
  vi.stubGlobal('molioNavigation', { openWiki })
  const text = '正文：[[八王之乱]]；[[wiki/entities/贾后|贾后]]，`[[代码]]`。\n\n```md\n[[示例]]\n```'
  render(<MarkdownDelegateProvider wikiCwd="/vault"><MarkdownText text={text} streaming={streaming}/></MarkdownDelegateProvider>)
  fireEvent.click(screen.getByRole('link', { name: '八王之乱' }))
  fireEvent.click(screen.getByRole('link', { name: '贾后' }))
  expect(openWiki.mock.calls).toEqual([['/vault', '八王之乱'], ['/vault', 'wiki/entities/贾后']])
  expect(screen.queryAllByRole('link')).toHaveLength(2)
})
