import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { ConflictResolution, ConnectParams, SiteInput, SyncStartRequest, TransferStartRequest } from '@shared/types'
import * as localFs from './local/fs'
import { SessionManager } from './sftp/manager'
import { checkPrivateKey } from './sftp/session'
import { TransferManager } from './sftp/transfer'
import { RsyncManager } from './rsync/runner'
import { deleteSite, consumeDataIssues, encryptionAvailable, getSiteWithSecret, listSites, saveSite } from './storage'

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(message)
  return value as Record<string, unknown>
}

function assertConnectParams(value: unknown): asserts value is ConnectParams {
  const params = assertObject(value, '无效的连接参数')
  if (
    typeof params.host !== 'string' ||
    !params.host.trim() ||
    typeof params.port !== 'number' ||
    !Number.isInteger(params.port) ||
    params.port < 1 ||
    params.port > 65535 ||
    typeof params.username !== 'string' ||
    !params.username.trim()
  ) {
    throw new Error('无效的连接参数')
  }
}

function assertSiteInput(value: unknown): asserts value is SiteInput {
  const input = assertObject(value, '无效的站点配置')
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error('站点名称不能为空')
  }
  if (typeof input.host !== 'string' || !input.host.trim()) {
    throw new Error('主机不能为空')
  }
  if (
    typeof input.port !== 'number' ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535
  ) {
    throw new Error('端口必须在 1-65535 之间')
  }
  if (typeof input.username !== 'string' || !input.username.trim()) {
    throw new Error('用户名不能为空')
  }
  if (input.authType !== 'password' && input.authType !== 'key') {
    throw new Error('无效的认证方式')
  }
}

function assertTransferStartRequest(value: unknown): asserts value is TransferStartRequest {
  const req = assertObject(value, '无效的传输请求')
  if (
    typeof req.sessionId !== 'string' ||
    !req.sessionId ||
    (req.direction !== 'upload' && req.direction !== 'download') ||
    !Array.isArray(req.sources) ||
    req.sources.length === 0 ||
    req.sources.some((item) => typeof item !== 'string' || !item.trim()) ||
    typeof req.targetDir !== 'string' ||
    !req.targetDir.trim()
  ) {
    throw new Error('无效的传输请求')
  }
}

function assertSyncStartRequest(value: unknown): asserts value is SyncStartRequest {
  const req = assertObject(value, '无效的同步请求')
  if (
    typeof req.sessionId !== 'string' ||
    !req.sessionId ||
    (req.direction !== 'upload' && req.direction !== 'download') ||
    typeof req.localPath !== 'string' ||
    !req.localPath.trim() ||
    typeof req.remotePath !== 'string' ||
    !req.remotePath.trim()
  ) {
    throw new Error('无效的同步请求')
  }
}

export function registerIpc(getWindow: () => BrowserWindow | null): {
  hasActiveWork: () => boolean
  disconnectAll: () => Promise<void>
  shutdown: () => Promise<void>
} {
  const getWebContents = () => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return null
    const contents = window.webContents
    return contents.isDestroyed() ? null : contents
  }
  const sessions = new SessionManager(getWebContents)
  const transfers = new TransferManager(getWebContents, sessions)
  const syncs = new RsyncManager(getWebContents, sessions)
  sessions.onSessionClosed((sessionId) => transfers.handleSessionClosed(sessionId))

  ipcMain.handle(IPC.appPickFile, async (_event, options?: { title?: string }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: options?.title ?? '选择文件',
      properties: ['openFile']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.appPickDirectory, async (_event, options?: { title?: string }) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: options?.title ?? '选择目录',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(IPC.localHome, () => localFs.localHome())
  ipcMain.handle(IPC.localList, (_event, target: string) => localFs.listLocal(target))
  ipcMain.handle(IPC.localMkdir, (_event, parent: string, name: string) =>
    localFs.makeDir(parent, name)
  )
  ipcMain.handle(IPC.localRename, (_event, target: string, newName: string) =>
    localFs.renameEntry(target, newName)
  )
  ipcMain.handle(IPC.localRemove, (_event, targets: string[]) => localFs.removeEntries(targets))
  ipcMain.handle(IPC.localChmod, (_event, target: string, mode: number) =>
    localFs.chmodEntry(target, mode)
  )
  ipcMain.handle(IPC.localOpenInBrowser, (_event, target: string) =>
    localFs.openInFileBrowser(target)
  )
  ipcMain.handle(IPC.localCleanTransientFiles, (_event, target: string) => {
    if (transfers.hasActiveTransferUnder(target, 'local')) {
      throw new Error('该目录有进行中的传输，暂不能清理临时文件')
    }
    return localFs.cleanTransientFiles(target)
  })

  ipcMain.handle(IPC.sftpConnect, (_event, params: ConnectParams) => {
    assertConnectParams(params)
    return sessions.connect(params)
  })
  ipcMain.handle(IPC.sftpConnectSite, async (_event, siteId: string) => {
    const record = await getSiteWithSecret(siteId)
    if (!record) throw new Error('站点不存在')
    const { site, secret } = record
    const useKey = site.authType === 'key'
    return sessions.connect({
      host: site.host,
      port: site.port,
      username: site.username,
      password: useKey ? undefined : secret.password,
      privateKeyPath: useKey ? site.keyPath : undefined,
      passphrase: useKey ? secret.passphrase : undefined
    })
  })
  ipcMain.handle(IPC.sftpDisconnect, (_event, sessionId: string) => sessions.disconnect(sessionId))
  ipcMain.handle(IPC.sftpList, (_event, sessionId: string, target: string) =>
    sessions.get(sessionId).list(target)
  )
  ipcMain.handle(IPC.sftpHome, (_event, sessionId: string) => sessions.get(sessionId).home())
  ipcMain.handle(IPC.sftpMkdir, (_event, sessionId: string, parent: string, name: string) =>
    sessions.get(sessionId).makeDir(parent, name)
  )
  ipcMain.handle(IPC.sftpRename, (_event, sessionId: string, target: string, newName: string) =>
    sessions.get(sessionId).renameEntry(target, newName)
  )
  ipcMain.handle(IPC.sftpRemove, (_event, sessionId: string, targets: string[]) =>
    sessions.get(sessionId).removeEntries(targets)
  )
  ipcMain.handle(IPC.sftpChmod, (_event, sessionId: string, target: string, mode: number) =>
    sessions.get(sessionId).chmodEntry(target, mode)
  )
  ipcMain.handle(IPC.sftpCheckKey, (_event, path: string, passphrase?: string) =>
    checkPrivateKey(path, passphrase)
  )
  ipcMain.handle(IPC.sftpCleanTransientFiles, (_event, sessionId: string, target: string) => {
    if (transfers.hasActiveTransferUnder(target, 'remote')) {
      throw new Error('该目录有进行中的传输，暂不能清理临时文件')
    }
    return sessions.get(sessionId).cleanTransientFiles(target)
  })

  ipcMain.handle(IPC.sitesList, () => listSites())
  ipcMain.handle(IPC.sitesSave, (_event, input: SiteInput) => {
    assertSiteInput(input)
    return saveSite(input)
  })
  ipcMain.handle(IPC.sitesDelete, (_event, id: string) => deleteSite(id))
  ipcMain.handle(IPC.sitesSecurity, () => ({ encryptionAvailable: encryptionAvailable() }))
  ipcMain.handle(IPC.sitesDataIssues, () => consumeDataIssues())

  ipcMain.handle(IPC.transferStart, (_event, req: TransferStartRequest) => {
    assertTransferStartRequest(req)
    return transfers.start(req)
  })
  ipcMain.handle(IPC.transferCancel, (_event, id: string) => transfers.cancel(id))
  ipcMain.handle(IPC.transferPause, (_event, id: string) => transfers.pause(id))
  ipcMain.handle(IPC.transferResume, (_event, id: string) => transfers.resume(id))
  ipcMain.handle(IPC.transferResolveConflict, (_event, id: string, resolution: ConflictResolution) =>
    transfers.resolveConflict(id, resolution)
  )
  ipcMain.handle(IPC.transferList, () => transfers.list())
  ipcMain.handle(IPC.transferListConflicts, () => transfers.pendingConflicts())
  ipcMain.handle(IPC.transferClearFinished, () => transfers.clearFinished())

  ipcMain.handle(IPC.syncStart, (_event, req: SyncStartRequest) => {
    assertSyncStartRequest(req)
    return syncs.start(req)
  })
  ipcMain.handle(IPC.syncCancel, (_event, id: string) => syncs.cancel(id))
  ipcMain.handle(IPC.syncGetLog, (_event, id: string) => syncs.getLog(id))
  ipcMain.handle(IPC.syncClearFinished, () => syncs.clearFinished())

  ipcMain.handle(
    IPC.hostkeyRespond,
    (_event, promptId: string, accept: boolean, remember: boolean) =>
      sessions.respondHostKey(promptId, accept, remember)
  )

  return {
    hasActiveWork: () =>
      transfers
        .list()
        .some(
          (group) =>
            group.status === 'active' || group.status === 'pending' || group.status === 'paused'
        ) || syncs.hasRunning(),
    disconnectAll: () => sessions.disconnectAll(),
    shutdown: async () => {
      transfers.cancelAll()
      try {
        await syncs.killAll()
        await sessions.disconnectAll()
      } catch {
        /* 清理失败不阻断退出 */
      }
    }
  }
}
