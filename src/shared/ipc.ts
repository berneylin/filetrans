export const IPC = {
  appPickFile: 'app:pick-file',
  appPickDirectory: 'app:pick-directory',

  localHome: 'local:home',
  localList: 'local:list',
  localMkdir: 'local:mkdir',
  localRename: 'local:rename',
  localRemove: 'local:remove',
  localChmod: 'local:chmod',

  sftpConnect: 'sftp:connect',
  sftpConnectSite: 'sftp:connect-site',
  sftpDisconnect: 'sftp:disconnect',
  sftpList: 'sftp:list',
  sftpHome: 'sftp:home',
  sftpMkdir: 'sftp:mkdir',
  sftpRename: 'sftp:rename',
  sftpRemove: 'sftp:remove',
  sftpChmod: 'sftp:chmod',
  sftpCheckKey: 'sftp:check-key',

  sitesList: 'sites:list',
  sitesSave: 'sites:save',
  sitesDelete: 'sites:delete',
  sitesSecurity: 'sites:security',

  transferStart: 'transfer:start',
  transferCancel: 'transfer:cancel',
  transferPause: 'transfer:pause',
  transferResume: 'transfer:resume',
  transferResolveConflict: 'transfer:resolve-conflict',
  transferList: 'transfer:list',
  transferListConflicts: 'transfer:list-conflicts',

  syncStart: 'sync:start',
  syncCancel: 'sync:cancel',
  syncGetLog: 'sync:get-log',

  hostkeyRespond: 'hostkey:respond',

  evtHostKeyPrompt: 'evt:hostkey-prompt',
  evtTransferUpdate: 'evt:transfer-update',
  evtConflictPrompt: 'evt:conflict-prompt',
  evtSessionClosed: 'evt:session-closed',
  evtHostKeyExpired: 'evt:hostkey-expired',
  evtConflictExpired: 'evt:conflict-expired',
  evtSyncUpdate: 'evt:sync-update'
} as const
