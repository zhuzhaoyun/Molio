import { useEffect, useState } from 'react'

export function MolioPreviewLocation({ path }: { path: string }) {
  const navigation = (globalThis as { molioNavigation?: {
    previewLocation(path: string, open: boolean): Promise<boolean>
  } }).molioNavigation
  const [available, setAvailable] = useState('')
  useEffect(() => {
    let active = true
    navigation?.previewLocation(path, false).then(found => {
      if (active) setAvailable(found ? path : '')
    }).catch(() => { if (active) setAvailable('') })
    return () => { active = false }
  }, [path, navigation])
  if (!navigation || available !== path) return null
  return <button type="button" data-testid="molio-preview-location" onClick={async () => {
    if (!await navigation.previewLocation(path, true).catch(() => false)) window.alert('文件所属知识库不可用')
  }}>在知识库中打开</button>
}
