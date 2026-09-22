import type {
  ConflictPrompt,
  ConflictResolution,
  ConnectParams,
  DirListing,
  HostKeyPrompt,
  KeyCheckResult,
  SessionInfo,
  SiteConfig,
  SiteInput,
  SyncJob,
  SyncStartRequest,
  TransferGroup,
  TransferStartRequest
} from './types'

export interface FileTransApi {
  pickFile(options?: { title?: string }): Promise<string | null>
  pickDirectory(options?: { title?: string }): Promise<string | null>
  getPathForFile(file: File): string
  local: {
    home(): Promise<string>
    list(path: string): Promise<DirListing>
    mkdir(parent: string, name: string): Promise<string>
    rename(path: string, newName: string): Promise<string>
    remove(paths: string[]): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    openInBrowser(path: string): Promise<void>
    cleanTransientFiles(path: string): Promise<number>
  }
  sftp: {
    connect(params: ConnectParams): Promise<SessionInfo>
    connectSite(siteId: string): Promise<SessionInfo>
    disconnect(sessionId: string): Promise<void>
    list(sessionId: string, path: string): Promise<DirListing>
    home(sessionId: string): Promise<string>
    mkdir(sessionId: string, parent: string, name: string): Promise<string>
    rename(sessionId: string, path: string, newName: string): Promise<string>
    remove(sessionId: string, paths: string[]): Promise<void>
    chmod(sessionId: string, path: string, mode: number): Promise<void>
    checkKey(path: string, passphrase?: string): Promise<KeyCheckResult>
    cleanTransientFiles(sessionId: string, path: string): Promise<number>
  }
  sites: {
    list(): Promise<SiteConfig[]>
    save(input: SiteInput): Promise<SiteConfig>
    remove(id: string): Promise<void>
    security(): Promise<{ encryptionAvailable: boolean }>
    dataIssues(): Promise<string[]>
  }
  transfers: {
    start(req: TransferStartRequest): Promise<string>
    cancel(id: string): Promise<void>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    resolveConflict(id: string, resolution: ConflictResolution): Promise<void>
    list(): Promise<TransferGroup[]>
    listConflicts(): Promise<ConflictPrompt[]>
    clearFinished(): Promise<void>
  }
  sync: {
    start(req: SyncStartRequest): Promise<string>
    cancel(id: string): Promise<void>
    getLog(id: string): Promise<string>
    clearFinished(): Promise<void>
  }
  hostkey: {
    respond(promptId: string, accept: boolean, remember: boolean): Promise<void>
  }
  events: {
    onHostKeyPrompt(cb: (prompt: HostKeyPrompt) => void): () => void
    onTransferUpdate(cb: (group: TransferGroup) => void): () => void
    onConflictPrompt(cb: (prompt: ConflictPrompt) => void): () => void
    onSessionClosed(cb: (sessionId: string) => void): () => void
    onHostKeyExpired(cb: (promptId: string) => void): () => void
    onConflictExpired(cb: (transferId: string) => void): () => void
    onSyncUpdate(cb: (job: SyncJob) => void): () => void
  }
}
