import { useEffect, useState } from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

type Vault = { id: string; path: string; name: string }
type Targets = { vaults: Vault[]; inferred?: string }
const bridge = () => (globalThis as { molioNavigation?: {
  targets(cwd: string): Promise<Targets>
  ingestDraft(id: string): Promise<string | null>
} }).molioNavigation

export function useMolioTarget(sessionId: string, cwd?: string, onPrepared?: () => void) {
  const key = 'molio.vault.' + sessionId
  const [data, setData] = useState<{ key: string; cwd?: string | undefined; targets: Targets }>()
  const [revision, refresh] = useState(0)
  const [error, setError] = useState('')
  const [needsVault, setNeedsVault] = useState(false)
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === key) refresh(value => value + 1)
    }
    window.addEventListener('molio:target-changed', changed)
    return () => window.removeEventListener('molio:target-changed', changed)
  }, [key])
  useEffect(() => {
    let active = true
    setNeedsVault(false)
    setError('')
    bridge()?.targets(cwd ?? '').then(targets => {
      if (!active) return
      if (targets.inferred && localStorage.getItem(key) === null) localStorage.setItem(key, targets.inferred)
      setData({ key, cwd, targets })
    }).catch(() => { if (active) setError('无法读取知识库列表') })
    return () => { active = false }
  }, [key, cwd, revision])
  const targets = data?.key === key && data.cwd === cwd ? data.targets : undefined
  const saved = localStorage.getItem(key)
  const vault = targets?.vaults.find(item => item.id === saved)
  async function ingest() {
    if (!vault) { setNeedsVault(true); return }
    try {
      const prompt = await bridge()?.ingestDraft(vault.id)
      if (!prompt) return
      const event = new CustomEvent('molio:session-draft', { cancelable: true, detail: { sessionId, prompt } })
      if (window.dispatchEvent(event)) throw new Error('当前会话无法接收草稿')
      onPrepared?.()
    } catch (reason) { window.alert(reason instanceof Error ? reason.message : '无法准备入库草稿') }
  }
  const controls = bridge() && <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingInline: 12 }}>
    <label>入库到 <select aria-label="入库目标知识库" data-testid="molio-session-vault" value={vault?.id ?? ''}
      onChange={event => {
        localStorage.setItem(key, event.target.value)
        setNeedsVault(false)
        window.dispatchEvent(new CustomEvent('molio:target-changed', { detail: key }))
      }}>
      <option value="">{saved && targets ? '所选知识库不可用，请重选' : '未选择知识库'}</option>
      {targets?.vaults.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <button type="button" data-testid="molio-ingest" onClick={ingest}>选择来源文件</button>
    {needsVault && <span role="status">请先选择入库目标知识库</span>}
    {error && <button type="button" onClick={() => refresh(value => value + 1)}>{error}，重试</button>}
  </div>
  return { controls, vault }
}

export function MolioTargetControls({ sessionId, cwd }: { sessionId: string; cwd?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const { controls } = useMolioTarget(sessionId, cwd, () => setOpen(false))
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent).detail === sessionId) setOpen(true) }
    window.addEventListener('molio:show-ingest', show)
    return () => window.removeEventListener('molio:show-ingest', show)
  }, [sessionId])
  return open ? <Modal open title="文件入库" closeLabel="关闭" onClose={() => setOpen(false)}>{controls}</Modal> : null
}
