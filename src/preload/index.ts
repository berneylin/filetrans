import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { FileTransApi } from '@shared/api'
import type {
  ConflictPrompt,
  ConflictResolution,
  HostKeyPrompt,
  SyncJob,
  SyncStartRequest,
  TransferGroup
} from '@shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''))
  }
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: FileTransApi = {
  pickFile: (options) => invoke(IPC.appPickFile, options),
  pickDirectory: (options) => invoke(IPC.appPickDirectory, options),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  local: {
    home: () => invoke(IPC.localHome),
    list: (path) => invoke(IPC.localList, path),
    mkdir: (parent, name) => invoke(IPC.localMkdir, parent, name),
    rename: (path, newName) => invoke(IPC.localRename, path, newName),
    remove: (paths) => invoke(IPC.localRemove, paths),
    chmod: (path, mode) => invoke(IPC.localChmod, path, mode)
  },

  sftp: {
    connect: (params) => invoke(IPC.sftpConnect, params),
    connectSite: (siteId) => invoke(IPC.sftpConnectSite, siteId),
    disconnect: (sessionId) => invoke(IPC.sftpDisconnect, sessionId),
    list: (sessionId, path) => invoke(IPC.sftpList, sessionId, path),
    home: (sessionId) => invoke(IPC.sftpHome, sessionId),
    mkdir: (sessionId, parent, name) => invoke(IPC.sftpMkdir, sessionId, parent, name),
    rename: (sessionId, path, newName) => invoke(IPC.sftpRename, sessionId, path, newName),
    remove: (sessionId, paths) => invoke(IPC.sftpRemove, sessionId, paths),
    chmod: (sessionId, path, mode) => invoke(IPC.sftpChmod, sessionId, path, mode),
    checkKey: (path, passphrase) => invoke(IPC.sftpCheckKey, path, passphrase)
  },

  sites: {
    list: () => invoke(IPC.sitesList),
    save: (input) => invoke(IPC.sitesSave, input),
    remove: (id) => invoke(IPC.sitesDelete, id),
    security: () => invoke(IPC.sitesSecurity),
    dataIssues: () => invoke<string[]>(IPC.sitesDataIssues)
  },

  transfers: {
    start: (req) => invoke(IPC.transferStart, req),
    cancel: (id) => invoke(IPC.transferCancel, id),
    pause: (id) => invoke(IPC.transferPause, id),
    resume: (id) => invoke(IPC.transferResume, id),
    resolveConflict: (id, resolution: ConflictResolution) =>
      invoke(IPC.transferResolveConflict, id, resolution),
    list: () => invoke(IPC.transferList),
    listConflicts: () => invoke(IPC.transferListConflicts)
  },

  sync: {
    start: (req: SyncStartRequest) => invoke(IPC.syncStart, req),
    cancel: (id) => invoke(IPC.syncCancel, id),
    getLog: (id) => invoke(IPC.syncGetLog, id)
  },

  hostkey: {
    respond: (promptId, accept, remember) =>
      invoke(IPC.hostkeyRespond, promptId, accept, remember)
  },

  events: {
    onHostKeyPrompt: (cb) => subscribe<HostKeyPrompt>(IPC.evtHostKeyPrompt, cb),
    onTransferUpdate: (cb) => subscribe<TransferGroup>(IPC.evtTransferUpdate, cb),
    onConflictPrompt: (cb) => subscribe<ConflictPrompt>(IPC.evtConflictPrompt, cb),
    onSessionClosed: (cb) => subscribe<string>(IPC.evtSessionClosed, cb),
    onHostKeyExpired: (cb) => subscribe<string>(IPC.evtHostKeyExpired, cb),
    onConflictExpired: (cb) => subscribe<string>(IPC.evtConflictExpired, cb),
    onSyncUpdate: (cb) => subscribe<SyncJob>(IPC.evtSyncUpdate, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
