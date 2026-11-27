// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MolioTargetControls, useMolioTarget } from '../src/client/chat/MolioTarget.tsx'

function Controls({ id }: { id: string }) {
  return useMolioTarget(id, '/workspace').controls
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

it('keeps the explicit target per session and refuses a missing target', async () => {
  const vaults = [{ id: 'a', name: '甲', path: '/a' }, { id: 'b', name: '乙', path: '/b' }]
  const targets = vi.fn(async () => ({ vaults, inferred: 'a' }))
  const ingestDraft = vi.fn(async () => null)
  vi.stubGlobal('molioNavigation', { targets, ingestDraft })
  const view = render(<Controls id="one"/>)
  const select = screen.getByRole('combobox') as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('a'))
  fireEvent.change(select, { target: { value: 'b' } })
  fireEvent.click(screen.getByTestId('molio-ingest'))
  expect(ingestDraft).toHaveBeenCalledWith('b')
  view.rerender(<Controls id="two"/>)
  await waitFor(() => expect(select.value).toBe('a'))
  vaults.pop()
  view.rerender(<Controls id="one"/>)
  await screen.findByText('所选知识库不可用，请重选')
  fireEvent.click(screen.getByTestId('molio-ingest'))
  expect(screen.getByRole('status').textContent).toContain('请先选择')
  expect(ingestDraft).toHaveBeenCalledTimes(1)
})

it('allows an unassociated workspace and prepares an ingest draft for its own session', async () => {
  const vault = { id: 'b', name: '乙', path: '/b' }
  const ingestDraft = vi.fn(async () => '保存来源到 /b')
  vi.stubGlobal('molioNavigation', { targets: async () => ({ vaults: [vault] }), ingestDraft })
  const received = vi.fn((event: Event) => event.preventDefault())
  window.addEventListener('molio:session-draft', received)
  try {
    render(<Controls id="ordinary"/>)
    await screen.findByRole('option', { name: '乙' })
    fireEvent.click(screen.getByTestId('molio-ingest'))
    expect(ingestDraft).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    fireEvent.click(screen.getByTestId('molio-ingest'))
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1))
    expect((received.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sessionId: 'ordinary', prompt: '保存来源到 /b' })
  } finally { window.removeEventListener('molio:session-draft', received) }
})

it('keeps the composer clear until ingest is invoked for this session', async () => {
  vi.stubGlobal('molioNavigation', { targets: async () => ({ vaults: [] }) })
  render(<MolioTargetControls sessionId="current" />)
  expect(screen.queryByRole('combobox')).toBeNull()
  fireEvent(window, new CustomEvent('molio:show-ingest', { detail: 'other' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent(window, new CustomEvent('molio:show-ingest', { detail: 'current' }))
  expect(await screen.findByRole('dialog', { name: '文件入库' })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('combobox')).toBeNull()
})
