export type EntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface FileEntry {
  name: string
  path: string
  type: EntryType
  size: number
  mtime: number
  atime: number
  mode: number
  isSymlink: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  entries: FileEntry[]
}

export interface SiteConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
  remotePath?: string
  rememberSecret: boolean
  hasSecret: boolean
}

export interface SiteInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  keyPath?: string
  passphrase?: string
  remotePath?: string
  rememberSecret: boolean
}

export interface ConnectParams {
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface KeyCheckResult {
  valid: boolean
  message?: string
}

export interface SessionInfo {
  sessionId: string
  host: string
  port: number
  username: string
}

export interface HostKeyInfo {
  host: string
  port: number
  fingerprint: string
  known: 'unknown' | 'trusted' | 'changed'
  previousFingerprint?: string
}

export interface HostKeyPrompt {
  promptId: string
  info: HostKeyInfo
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export type TransferDirection = 'upload' | 'download'

export type TransferStatus = 'pending' | 'active' | 'paused' | 'done' | 'error' | 'cancelled'

export interface TransferOptions {
  resume: boolean
  retries: number
  /** 单文件并行分块下载数，1 表示关闭并行 */
  concurrency: number
  preserveTimestamps: boolean
  preservePermissions: boolean
}

export interface TransferStartRequest {
  sessionId: string
  direction: TransferDirection
  sources: string[]
  targetDir: string
  recursive: boolean
  options?: Partial<TransferOptions>
}

export interface TransferFileProgress {
  id: number
  name: string
  path: string
  size: number
  transferred: number
  speed: number
}

export interface TransferFailure {
  id: number
  name: string
  path: string
  error: string
}

export interface TransferGroup {
  id: string
  sessionId: string
  direction: TransferDirection
  sourceLabel: string
  targetDir: string
  status: TransferStatus
  totalFiles: number
  doneFiles: number
  totalBytes: number
  transferredBytes: number
  speed: number
  activeFiles?: TransferFileProgress[]
  failedFiles?: TransferFailure[]
  failedCount?: number
  error?: string
  retryCount?: number
  startedAt: number
  finishedAt?: number
}

export interface ConflictItem {
  targetPath: string
  size: number
  type: 'file' | 'directory' | 'symlink'
}

export interface ConflictPrompt {
  transferId: string
  items: ConflictItem[]
}

export type ConflictResolution = 'overwrite' | 'resume' | 'skip' | 'cancel'

export type SyncDirection = 'upload' | 'download'

export type SyncStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface SyncOptions {
  deleteExtraneous: boolean
  exclude: string[]
  compress: boolean
}

export interface SyncStartRequest {
  sessionId: string
  direction: SyncDirection
  localPath: string
  remotePath: string
  options?: Partial<SyncOptions>
}

export interface SyncJob {
  id: string
  direction: SyncDirection
  localPath: string
  remotePath: string
  status: SyncStatus
  percent: number
  transferredBytes: number
  speed: number
  currentFile?: string
  transferredFiles: number
  error?: string
  startedAt: number
  finishedAt?: number
}
