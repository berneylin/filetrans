import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { ConflictResolution, ConnectParams, SiteInput, SyncStartRequest, TransferStartRequest } from '@shared/types'
import * as localFs from './local/fs'
import { SessionManager } from './sftp/manager'
import { checkPrivateKey } from './sftp/session'
import { TransferManager } from './sftp/transfer'
import { RsyncManager } from './rsync/runner'
import { deleteSite, encryptionAvailable, getSiteWithSecret, listSites, saveSite } from './storage'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const getWebContents = () => getWindow()?.webContents ?? null
  const sessions = new SessionManager(getWebContents)
  const transfers = new TransferManager(getWebContents, sessions)
  const syncs = new RsyncManager(getWebContents, sessions)

  app.once('before-quit', () => {
    transfers.cancelAll()
    void syncs.killAll()
    void sessions.disconnectAll()
  })

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

  ipcMain.handle(IPC.sftpConnect, (_event, params: ConnectParams) => sessions.connect(params))
  ipcMain.handle(IPC.sftpConnectSite, async (_event, siteId: string) => {
    const record = await getSiteWithSecret(siteId)
    if (!record) throw new Error('站点不存在')
    const { site, secret } = record
    return sessions.connect({
      host: site.host,
      port: site.port,
      username: site.username,
      password: secret.password,
      privateKeyPath: site.authType === 'key' ? site.keyPath : undefined,
      passphrase: secret.passphrase
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

  ipcMain.handle(IPC.sitesList, () => listSites())
  ipcMain.handle(IPC.sitesSave, (_event, input: SiteInput) => saveSite(input))
  ipcMain.handle(IPC.sitesDelete, (_event, id: string) => deleteSite(id))
  ipcMain.handle(IPC.sitesSecurity, () => ({ encryptionAvailable: encryptionAvailable() }))

  ipcMain.handle(IPC.transferStart, (_event, req: TransferStartRequest) => transfers.start(req))
  ipcMain.handle(IPC.transferCancel, (_event, id: string) => transfers.cancel(id))
  ipcMain.handle(IPC.transferPause, (_event, id: string) => transfers.pause(id))
  ipcMain.handle(IPC.transferResume, (_event, id: string) => transfers.resume(id))
  ipcMain.handle(IPC.transferResolveConflict, (_event, id: string, resolution: ConflictResolution) =>
    transfers.resolveConflict(id, resolution)
  )
  ipcMain.handle(IPC.transferList, () => transfers.list())
  ipcMain.handle(IPC.transferListConflicts, () => transfers.pendingConflicts())

  ipcMain.handle(IPC.syncStart, (_event, req: SyncStartRequest) => syncs.start(req))
  ipcMain.handle(IPC.syncCancel, (_event, id: string) => syncs.cancel(id))
  ipcMain.handle(IPC.syncGetLog, (_event, id: string) => syncs.getLog(id))

  ipcMain.handle(
    IPC.hostkeyRespond,
    (_event, promptId: string, accept: boolean, remember: boolean) =>
      sessions.respondHostKey(promptId, accept, remember)
  )
}
