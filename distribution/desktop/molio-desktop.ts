import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { knowledgeDraft, type ContextRequest } from './molio-compose.js'
import { clipperRoute } from './molio-clipper.js'

let deliverClip: ((route: string) => void) | undefined
let pendingClip: string | undefined

export function installMolioProtocol(focusHost: () => void) {
  const receive = (input: string) => {
    const route = clipperRoute(input)
    if (!route) return
    if (route === '/') focusHost()
    else if (deliverClip) deliverClip(route)
    else pendingClip = route
  }
  for (const arg of process.argv) receive(arg)
  app.on('second-instance', (_event, argv) => { for (const arg of argv) receive(arg) })
  app.on('open-url', (event, url) => {
    if (url.startsWith('molio://')) { event.preventDefault(); receive(url) }
  })
}

let productWindow: (() => BrowserWindow) | undefined

export function bindMolioConversationWindow(getWindow: () => BrowserWindow) {
  productWindow = getWindow
}

const documentTypes = new Set(['.md', '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp3', '.mp4', '.wav'])
const menuRoutes = [
  ['知识库', '/knowledge'], ['知识图谱', '/knowledge?panel=graph'], ['资源市场', '/resources'],
] as const

export async function startMolioDesktop() {
  const directory = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const support = join(directory, 'molio-support')
  const crypto = await import(pathToFileURL(join(support, 'crypto-server.mjs')).href)
  const sidecar = await import(pathToFileURL(join(support, 'sidecar.mjs')).href)
  const token = randomBytes(32).toString('hex')
  const cryptoPort = await crypto.startCryptoServer(safeStorage, { token })
  const windows = new Set<BrowserWindow>()
  let running = true
  const cleanup = () => {
    if (!running) return
    running = false
    for (const window of windows) window.destroy()
    void crypto.stopCryptoServer()
  }
  let documents: string
  try {
    documents = app.getPath('documents')
  } catch {
    // A new or redirected Windows profile may have no registered Documents folder yet.
    documents = join(app.getPath('home'), 'Documents')
  }
  const resources = join(directory, app.isPackaged ? 'molio' : 'molio-resources')
  const dshDirectory = app.isPackaged ? join(app.getAppPath(), 'dsh')
    : process.env.DSH_DESKTOP_DSH_DIR || join(app.getAppPath(), '.desktop-build/development/project')
  const service = await sidecar.startSidecar(resources, {
    MOLIO_HARNESS_EXECUTABLE: process.execPath,
    MOLIO_HARNESS_CLI: join(dshDirectory, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'),
    MOLIO_HARNESS_SUGGEST_PATCH: join(support, 'suggest.patch.yml'),
    MOLIO_DOCUMENTS_DIR: documents,
    MOLIO_DESKTOP_CRYPTO_PORT: String(cryptoPort),
    MOLIO_DESKTOP_CRYPTO_TOKEN: token,
  }, cleanup).catch((error: unknown) => { cleanup(); throw error })
  process.env.MOLIO_PORT = String(service.port)
  const origin = `http://127.0.0.1:${service.port}`
  app.once('will-quit', () => service.stop())

  const open = async (route: string, newWindow = false) => {
    if (!running) throw new Error('知识库服务已停止，请重新启动应用。')
    const target = new URL(route, origin)
    if (target.origin !== origin || !/^\/(knowledge|resources(?:\/[^/]+)?|me)$/.test(target.pathname)) {
      throw new Error('Invalid Molio page')
    }
    let window = newWindow ? undefined : [...windows][0]
    if (!window) {
      const created = new BrowserWindow({
        width: 1260, height: 850, title: 'Molio',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(support, 'preload.cjs') },
      })
      windows.add(created)
      created.on('closed', () => windows.delete(created))
      created.webContents.setWindowOpenHandler(({ url }) => {
        const link = new URL(url)
        if (link.origin === origin) void open(link.href, true).catch(console.error)
        else if (link.protocol === 'https:') void shell.openExternal(link.href).catch(console.error)
        return { action: 'deny' }
      })
      created.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== origin) event.preventDefault()
      })
      window = created
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    await window.loadURL(target.href)
  }
  const owner = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!running || !window || !windows.has(window) || event.senderFrame !== event.sender.mainFrame
      || new URL(event.sender.mainFrame.url).origin !== origin) throw new Error('Unknown Molio window')
    return window
  }
  const vaultFile = async (event: IpcMainInvokeEvent, path: unknown) => {
    owner(event)
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid vault path')
    const target = await realpath(path)
    const response = await fetch(origin + '/api/knowledge/vaults')
    if (!response.ok) throw new Error('Knowledge service unavailable')
    const { vaults } = await response.json() as { vaults: Array<{ path: string }> }
    for (const vault of vaults) {
      const root = await realpath(vault.path).catch(() => undefined)
      if (root === undefined) continue
      const diff = relative(root, target)
      if (!isAbsolute(diff) && diff !== '..' && !diff.startsWith('..' + sep)) return target
    }
    throw new Error('File outside registered vaults')
  }
  ipcMain.handle('molio:conversation', async (event, input: ContextRequest) => {
    owner(event)
    const prompt = knowledgeDraft(input, join(resources, 'daemon/skills'))
    const response = await fetch(origin + '/api/knowledge/vaults')
    if (!response.ok) throw new Error('知识库服务不可用')
    const { vaults } = await response.json() as { vaults: Array<{ id: string; path: string }> }
    const vault = vaults.find(item => item.id === input.vaultId)
    if (!vault || relative(vault.path, input.vaultPath) !== '') throw new Error('知识库目录已变更，请刷新后重试')
    const host = productWindow?.()
    if (!host || host.isDestroyed()) throw new Error('请先打开 Harness 工作区')
    const { port1, port2 } = new MessageChannelMain()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { port1.close(); reject(new Error('Harness 会话未就绪，请稍后重试')) }, 15000)
      port1.once('message', ({ data }) => {
        clearTimeout(timer)
        port1.close()
        if (data?.ok) resolve()
        else reject(new Error(String(data?.error ?? '无法打开会话')))
      })
      port1.start()
      host.webContents.postMessage('molio:compose', { path: vault.path, prompt }, [port2])
    })
    if (host.isMinimized()) host.restore()
    host.show()
    host.focus()
  })
  ipcMain.handle('molio:directory', async event => {
    const result = await dialog.showOpenDialog(owner(event), { properties: ['openDirectory'] })
    return result.filePaths[0] ?? null
  })
  ipcMain.handle('molio:reveal', async (event, path: unknown) => shell.showItemInFolder(await vaultFile(event, path)))
  ipcMain.handle('molio:open', async (event, path: unknown) => {
    const target = await vaultFile(event, path)
    if (!documentTypes.has(extname(target).toLowerCase())) {
      shell.showItemInFolder(target)
      return ''
    }
    return shell.openPath(target)
  })
  ipcMain.handle('molio:window', async (event, route: string) => {
    owner(event)
    await open(route, true)
    return { ok: true }
  })
  deliverClip = route => {
    const existing = [...windows][0]
    if (!existing || existing.webContents.isLoadingMainFrame()) {
      void open(route).catch(error => dialog.showErrorBox('Molio', String(error)))
      return
    }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    existing.webContents.send('molio:clip-route', route)
  }
  if (pendingClip) { deliverClip(pendingClip); pendingClip = undefined }
  return menuRoutes.map(([label, route]) => ({
    label, click: () => { void open(route).catch(e => dialog.showErrorBox('Molio', String(e))) },
  }))
}
