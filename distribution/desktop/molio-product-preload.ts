import { contextBridge, ipcRenderer } from 'electron'

type Draft = { path: string; prompt: string }

// Only the product page gets this bridge. Replies use a private one-shot port
// from main, so a stale renderer cannot acknowledge another window's request.
export function installKnowledgeComposer() {
  contextBridge.exposeInMainWorld('molioNavigation', {
    openWiki: (cwd: string, page: string) => ipcRenderer.invoke('molio:wiki', cwd, page),
    listen: (callback: (url: string) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
      ipcRenderer.on('molio:panel', handle)
      ipcRenderer.send('molio:panel-ready')
      return () => { ipcRenderer.off('molio:panel', handle) }
    },
    open: (id: string) => ipcRenderer.send('molio:navigate', id),
  })
  contextBridge.exposeInMainWorld('molioKnowledgeComposer', {
    listen: (callback: (draft: Draft) => Promise<void>) => {
      const handle = (event: Electron.IpcRendererEvent, draft: Draft) => {
        const port = event.ports[0]
        if (!port) return
        Promise.resolve().then(() => callback(draft)).then(() => port.postMessage({ ok: true }),
          error => port.postMessage({ error: error instanceof Error ? error.message : String(error) })).finally(() => port.close())
      }
      ipcRenderer.on('molio:compose', handle)
      return () => { ipcRenderer.removeListener('molio:compose', handle) }
    },
  })
}
