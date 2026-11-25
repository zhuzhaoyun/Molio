import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, safeStorage, shell, session, type WebContents, type WebPreferences, type IpcMainInvokeEvent } from 'electron'
import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { knowledgeDraft, type ContextRequest } from './molio-compose.js'
import { clipperRoute } from './molio-clipper.js'

let deliverClip: ((route: string) => void) | undefined
let pendingClip: string | undefined
let workspaceEntered: (() => boolean) | undefined

export function flushMolioClip() {
  if (pendingClip && deliverClip && workspaceEntered?.()) {
    deliverClip(pendingClip)
    pendingClip = undefined
  }
}

export function installMolioProtocol(focusHost: () => void) {
  const receive = (input: string) => {
    const route = clipperRoute(input)
    if (!route) return
    if (route === '/') focusHost()
    else { pendingClip = route; flushMolioClip() }
  }
  for (const arg of process.argv) receive(arg)
  app.on('second-instance', (_event, argv) => { for (const arg of argv) receive(arg) })
  app.on('open-url', (event, url) => {
    if (url.startsWith('molio://')) { event.preventDefault(); receive(url) }
  })
}

let productWindow: (() => BrowserWindow | undefined) | undefined

export function bindMolioConversationWindow(getWindow: () => BrowserWindow | undefined, entered: () => boolean) {
  workspaceEntered = entered
  productWindow = getWindow
}

const documentTypes = new Set(['.md', '.txt', '.csv', '.pdf', '.docx', '.xlsx', '.pptx', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp3', '.mp4', '.wav'])
const moduleRoutes = new Map([['knowledge', '/knowledge?panel=files'], ['graph', '/knowledge?panel=graph'], ['resources', '/resources']])

const partition = 'persist:molio-knowledge'
let serviceOrigin: string
let guestPreload: string
const guests = new Set<WebContents>()

function pageUrl(route: string) {
  const url = new URL(route, serviceOrigin)
  if (url.origin !== serviceOrigin || !/^\/(knowledge|resources(?:\/[^/]+)?|me)$/.test(url.pathname)) throw new Error('Invalid Molio page')
  return url
}

export function attachMolioPanel(owner: WebContents, preferences: WebPreferences, params: Record<string, string>) {
  if (params.partition !== partition) return false
  if (!owner.getURL().startsWith('dsh-app://app/') || owner !== productWindow?.()?.webContents) throw new Error('Unknown panel owner')
  pageUrl(params.src ?? '')
  for (const key of Object.keys(preferences)) Reflect.deleteProperty(preferences, key)
  Object.assign(preferences, { partition, preload: guestPreload, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, webviewTag: false, disablePopups: false })
  return true
}

export function bindMolioPanel(owner: WebContents, guest: WebContents) {
  if (guest.session !== session.fromPartition(partition)) return false
  guests.add(guest)
  guest.once('destroyed', () => guests.delete(guest))
  guest.on('will-attach-webview', event => event.preventDefault())
  guest.on('will-frame-navigate', event => {
    if (event.isMainFrame && new URL(event.url).origin !== serviceOrigin) event.preventDefault()
  })
  guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
    if (mainFrame && new URL(url).origin !== serviceOrigin) event.preventDefault()
  })
  guest.setWindowOpenHandler(({ url }) => {
    const link = new URL(url)
    if (link.origin === serviceOrigin) owner.send('molio:panel', pageUrl(link.href).href)
    else if (link.protocol === 'https:') void shell.openExternal(link.href).catch(console.error)
    return { action: 'deny' }
  })
  return true
}

export async function startMolioDesktop() {
  const directory = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const support = join(directory, 'molio-support')
  const crypto = await import(pathToFileURL(join(support, 'crypto-server.mjs')).href)
  const sidecar = await import(pathToFileURL(join(support, 'sidecar.mjs')).href)
  const token = randomBytes(32).toString('hex')
  const cryptoPort = await crypto.startCryptoServer(safeStorage, { token })
  guestPreload = join(support, 'preload.cjs')
  let running = true
  const cleanup = () => {
    if (!running) return
    running = false
    for (const guest of guests) guest.close()
    void crypto.stopCryptoServer()
  }
  let documents: string
  try {
    documents = app.getPath('documents')
  } catch {
    // A new or redirected Windows profile may have no registered Documents folder yet.
    documents = join(app.getPath('home'), 'Documents')
  }
  const resources = join(directory, app.isPackaged ? 'molio' : 'molio-plugin-resources')
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

  serviceOrigin = origin
  const owner = (event: IpcMainInvokeEvent) => {
    const host = productWindow?.()
    if (!running || !host || !guests.has(event.sender) || event.sender.hostWebContents !== host.webContents
      || event.senderFrame !== event.sender.mainFrame || new URL(event.sender.getURL()).origin !== origin) throw new Error('Unknown Molio panel')
    return host
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
    owner(event).webContents.send('molio:panel', pageUrl(route).href)
    return { ok: true }
  })
  ipcMain.on('molio:panel-ready', event => {
    const host = productWindow?.()
    if (!host || event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame) return
    deliverClip = route => {
      host.webContents.send('molio:panel', pageUrl(route).href)
      if (host.isMinimized()) host.restore()
      host.show()
      host.focus()
    }
    host.webContents.once('destroyed', () => { deliverClip = undefined })
    flushMolioClip()
  })
  ipcMain.on('molio:navigate', (event, id: string) => {
    const host = productWindow?.()
    if (!host || event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame) return
    const route = moduleRoutes.get(id)
    if (route) host.webContents.send('molio:panel', pageUrl(route).href)
  })
}
