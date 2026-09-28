import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type MessageBoxOptions
} from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'

app.setName('FileTrans')

type Bridge = ReturnType<typeof registerIpc>

let mainWindow: BrowserWindow | null = null
let forceClose = false
let quitConfirmed = false
let quitPrompting = false
let quitting = false

async function confirmStopWork(bridge: Bridge, confirmLabel: string): Promise<boolean> {
  if (!bridge.hasActiveWork()) return true
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: [confirmLabel, '取消'],
    defaultId: 1,
    cancelId: 1,
    message: '有进行中的传输或同步任务',
    detail: '继续将取消这些任务，确定要继续吗？'
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

function createWindow(bridge: Bridge): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 620,
    title: 'FileTrans',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 1.25
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (quitting || forceClose || !bridge.hasActiveWork()) return
    event.preventDefault()
    const target = mainWindow
    if (!target) return
    const darwin = process.platform === 'darwin'
    void confirmStopWork(bridge, darwin ? '关闭窗口并取消任务' : '退出并取消任务').then(
      async (ok) => {
        if (!ok) return
        if (darwin) await bridge.shutdown()
        else quitConfirmed = true
        forceClose = true
        if (!target.isDestroyed()) target.close()
      }
    )
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    forceClose = false
    if (process.platform === 'darwin') void bridge.disconnectAll()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const indexFile = path.join(__dirname, '../renderer/index.html')
  const indexUrl = pathToFileURL(indexFile).href
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.split('#')[0] === indexUrl
    if (!allowed) event.preventDefault()
  })

  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(indexFile)
  }
}

async function cleanupTempFiles(): Promise<void> {
  const dir = app.getPath('userData')
  const entries = await fs.readdir(dir).catch(() => [])
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') {
      const menu = Menu.buildFromTemplate([
        {
          label: '编辑',
          submenu: [
            { role: 'undo', label: '撤销' },
            { role: 'redo', label: '重做' },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' }
          ] satisfies MenuItemConstructorOptions[]
        }
      ])
      Menu.setApplicationMenu(menu)
    }
    const bridge = registerIpc(() => mainWindow)
    app.on('before-quit', (event) => {
      if (quitting) return
      event.preventDefault()
      if (quitPrompting) return
      quitPrompting = true
      void (async () => {
        try {
          if (!quitConfirmed && !(await confirmStopWork(bridge, '退出并取消任务'))) return
          quitting = true
          await bridge.shutdown()
          app.exit(0)
        } finally {
          quitPrompting = false
        }
      })()
    })
    createWindow(bridge)
    void cleanupTempFiles()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(bridge)
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
