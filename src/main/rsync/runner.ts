import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import os from 'node:os'
import path from 'node:path'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { findBannedDir } from '@shared/path'
import type { SyncJob, SyncStartRequest } from '@shared/types'
import type { SessionManager } from '../sftp/manager'
import { type SftpSession } from '../sftp/session'
import {
  buildAskpassScript,
  buildRshScript,
  buildRsyncArgs,
  buildSshConfig,
  knownHostsLine,
  parseHostKeyAlgorithm
} from './args'
import {
  resolveRsync,
  parseRsyncVersion,
  type ParsedRsyncVersion,
  type RsyncDialect,
  type RsyncInfo
} from './detect'
import { normalizeNameLine, parseProgressLine, type RsyncProgress } from './progress'

const EMIT_INTERVAL_MS = 300
const KILL_GRACE_MS = 3000
const LOG_MAX_LINES = 500

interface SyncState {
  job: SyncJob
  child: ChildProcess | null
  cancelled: boolean
  logLines: string[]
  lastEmit: number
  tempDir: string | null
  forceKillTimer?: NodeJS.Timeout
  leftover: string
  dialect: RsyncDialect
  progress2: boolean
  completedBytes: number
  completedFiles: number
  totalFiles: number | null
  currentBytes: number
  lastBytes: number
  lastSpeedAt: number
  closed: Promise<void>
  resolveClosed: () => void
}

function pickTempRoot(): string {
  const tmp = os.tmpdir()
  if (!/[\s"\\]/.test(tmp)) return tmp
  return '/tmp'
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function spaceFree(input: string): boolean {
  return !/[\s"\\]/.test(input)
}

export class RsyncManager {
  private jobs = new Map<string, SyncState>()
  private info: RsyncInfo | null = null

  constructor(
    private getWebContents: () => WebContents | null,
    private sessions: SessionManager
  ) {}

  private async probeRsync(): Promise<RsyncInfo> {
    if (!this.info) this.info = await resolveRsync()
    return this.info
  }

  private async probeRemoteRsync(session: SftpSession): Promise<ParsedRsyncVersion | null> {
    try {
      const result = await session.exec('rsync --version')
      if (result.code !== 0 || !result.stdout) return null
      return parseRsyncVersion(result.stdout)
    } catch {
      return null
    }
  }

  async start(req: SyncStartRequest): Promise<string> {
    const info = await this.probeRsync()
    const session: SftpSession = this.sessions.get(req.sessionId)
    const params = session.params
    const hostKeyBlob = session.hostKey
    if (!hostKeyBlob) throw new Error('主机公钥尚未记录，请重新连接站点后再同步')
    const remote = await this.probeRemoteRsync(session)

    const options = {
      deleteExtraneous: req.options?.deleteExtraneous ?? false,
      compress: req.options?.compress ?? true,
      exclude: req.options?.exclude ?? []
    }

    const localPath = req.localPath.trim()
    let remotePath = req.remotePath.trim()
    if (!localPath || !remotePath) throw new Error('本地目录与远程目录均不能为空')
    if (req.direction !== 'upload' && req.direction !== 'download') {
      throw new Error('无效的同步方向')
    }

    remotePath = await session.resolvePath(remotePath)
    const bannedDirs = req.bannedDirs ?? []
    if (bannedDirs.length > 0) {
      const localBanned = findBannedDir(localPath, bannedDirs)
      if (localBanned) throw new Error(`本地目录已被禁用同步: ${localBanned}`)
      const remoteBanned = findBannedDir(remotePath, bannedDirs)
      if (remoteBanned) throw new Error(`远程目录已被禁用同步: ${remoteBanned}`)
    }

    const upload = req.direction === 'upload'
    if (upload) {
      const srcStats = await fs.stat(localPath).catch(() => null)
      if (!srcStats?.isDirectory()) throw new Error(`本地源目录不存在或不是目录: ${localPath}`)
      const dstStats = await session.stat(remotePath).catch(() => null)
      if (dstStats && !dstStats.isDirectory()) {
        throw new Error(`远程目标不是目录: ${remotePath}`)
      }
      if (!dstStats) await session.mkdirp(remotePath)
    } else {
      const srcStats = await session.stat(remotePath).catch(() => null)
      if (!srcStats?.isDirectory()) throw new Error(`远程源目录不存在或不是目录: ${remotePath}`)
      const dstStats = await fs.stat(localPath).catch(() => null)
      if (dstStats && !dstStats.isDirectory()) {
        throw new Error(`本地目标不是目录: ${localPath}`)
      }
      await fs.mkdir(localPath, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
        throw new Error(`无法创建本地目标目录 ${localPath}: ${err.message}`)
      })
    }

    const id = randomUUID()
    const tempRoot = pickTempRoot()
    const tempDir = path.join(tempRoot, `filetrans-sync-${id}`)
    if (!spaceFree(tempDir)) throw new Error('临时目录路径包含空格，无法创建同步环境')
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 })

    let job: SyncJob
    let args: string[]
    let env: NodeJS.ProcessEnv
    let state: SyncState
    try {
      const knownHostsFile = path.join(tempDir, 'known_hosts')
      const keyType = parseHostKeyAlgorithm(hostKeyBlob)
      if (!keyType) throw new Error('无法识别主机公钥类型')
      await fs.writeFile(
        knownHostsFile,
        knownHostsLine(params.host, params.port, keyType, hostKeyBlob.toString('base64')),
        { mode: 0o600 }
      )

      const keyPath = params.privateKeyPath ? expandHome(params.privateKeyPath) : undefined
      const configPath = path.join(tempDir, 'ssh_config')
      await fs.writeFile(
        configPath,
        buildSshConfig({
          host: params.host,
          port: params.port,
          user: params.username,
          knownHostsFile,
          keyPath,
          connectTimeout: 20
        }),
        { mode: 0o600 }
      )

      const rshPath = path.join(tempDir, 'rsh')
      await fs.writeFile(rshPath, buildRshScript(configPath), { mode: 0o755 })

      const secret = keyPath ? params.passphrase : params.password
      let askpassPath: string | undefined
      if (secret) {
        askpassPath = path.join(tempDir, 'askpass')
        await fs.writeFile(askpassPath, buildAskpassScript(), { mode: 0o700 })
      }

      const modernGnu = info.dialect === 'gnu' && info.modern
      const progress2 = modernGnu && remote?.dialect === 'gnu' && remote.modern
      const argProtected = modernGnu && info.argProtected
      const zstd = modernGnu && info.zstd && remote?.zstd === true
      args = buildRsyncArgs({
        direction: req.direction,
        localPath,
        remotePath,
        user: params.username,
        host: params.host,
        rsh: rshPath,
        deleteExtraneous: options.deleteExtraneous,
        exclude: options.exclude,
        compress: options.compress,
        modernGnu,
        progress2,
        argProtected,
        zstd
      })

      env = { ...process.env }
      delete env.SSH_ASKPASS
      delete env.SSH_ASKPASS_REQUIRE
      if (askpassPath) {
        env.SSH_ASKPASS = askpassPath
        env.SSH_ASKPASS_REQUIRE = 'force'
        env.FILETRANS_SSH_SECRET = secret
      }

      job = {
        id,
        direction: req.direction,
        localPath,
        remotePath,
        status: 'running',
        percent: 0,
        transferredBytes: 0,
        speed: 0,
        transferredFiles: 0,
        startedAt: Date.now()
      }
      state = {
        job,
        child: null,
        cancelled: false,
        logLines: [],
        lastEmit: 0,
        tempDir,
        leftover: '',
        dialect: info.dialect,
        progress2,
        completedBytes: 0,
        completedFiles: 0,
        totalFiles: null,
        currentBytes: 0,
        lastBytes: 0,
        lastSpeedAt: Date.now(),
        closed: Promise.resolve(),
        resolveClosed: () => undefined
      }
      state.closed = new Promise<void>((resolve) => {
        state.resolveClosed = resolve
      })
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    this.jobs.set(id, state)
    this.emit(state)
    this.launch(state, info, remote, args, env)
    return id
  }

  private launch(
    state: SyncState,
    info: RsyncInfo,
    remote: ParsedRsyncVersion | null,
    args: string[],
    env: NodeJS.ProcessEnv
  ): void {
    this.appendLog(state.logLines, `# 使用 ${info.label}: ${info.path}`)
    this.appendLog(
      state.logLines,
      remote
        ? `# 远端 rsync: ${remote.dialect === 'openrsync' ? 'openrsync' : 'GNU rsync'} ${remote.version}`
        : '# 远端 rsync: 未检测到，使用保守参数（无 -s/zstd）'
    )
    this.appendLog(state.logLines, `$ rsync ${args.join(' ')}`)
    const child = spawn(info.path, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    state.child = child
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) =>
      this.consume(state, stdoutDecoder.write(chunk), state.logLines)
    )
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendLog(state.logLines, stderrDecoder.write(chunk))
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (state.cancelled) return
      state.job.error =
        err.code === 'ENOENT' ? '未检测到 rsync，无法执行同步' : `rsync 启动失败: ${err.message}`
      state.job.status = 'error'
      state.child = null
      state.job.finishedAt = Date.now()
      state.resolveClosed()
      void this.cleanupTemp(state)
      this.emit(state)
    })
    child.on('close', (code) => {
      if (state.forceKillTimer) clearTimeout(state.forceKillTimer)
      if (state.cancelled) {
        state.job.status = 'cancelled'
      } else if (state.job.error) {
        state.job.status = 'error'
      } else if (code === 0) {
        state.job.status = 'done'
      } else if (code === 24 && state.dialect === 'gnu') {
        state.job.status = 'done'
        this.appendLog(state.logLines, '[警告] 部分源文件在传输过程中消失 (rsync 24)')
      } else if (code === 2 && state.dialect === 'openrsync') {
        state.job.status = 'error'
        state.job.error = '远端 rsync 协议版本不兼容（openrsync 要求协议 29 及以上）'
      } else {
        state.job.status = 'error'
        state.job.error = state.job.error ?? `rsync 异常退出 (代码 ${code})`
      }
      state.child = null
      if (state.job.status === 'done') state.job.percent = 100
      state.job.speed = 0
      state.job.finishedAt = Date.now()
      state.resolveClosed()
      void this.cleanupTemp(state)
      this.emit(state)
    })
  }

  private consume(state: SyncState, text: string, logSink: string[]): void {
    const combined = state.leftover + text
    const parts = combined.split(/[\r\n]/)
    state.leftover = parts.pop() ?? ''
    for (const segment of parts) {
      if (!segment) continue
      const progress = parseProgressLine(segment, state.dialect)
      if (progress) {
        if (state.progress2) {
          if (progress.bytes !== null) state.job.transferredBytes = progress.bytes
          if (progress.percent !== null) state.job.percent = progress.percent
          if (progress.speedBytesPerSec !== null) state.job.speed = progress.speedBytesPerSec
          if (progress.transferredFiles !== null)
            state.job.transferredFiles = progress.transferredFiles
        } else {
          this.applyLegacyProgress(state, progress)
        }
        const now = Date.now()
        if (now - state.lastEmit >= EMIT_INTERVAL_MS) this.emit(state)
        continue
      }
      const name = normalizeNameLine(segment)
      if (name) {
        state.job.currentFile = name
        this.appendLog(logSink, segment)
        const now = Date.now()
        if (now - state.lastEmit >= EMIT_INTERVAL_MS) this.emit(state)
        continue
      }
      this.appendLog(logSink, segment)
    }
  }

  private applyLegacyProgress(state: SyncState, progress: RsyncProgress): void {
    if (state.dialect === 'openrsync') {
      if (progress.finished) {
        state.completedBytes += progress.bytes ?? 0
        state.currentBytes = 0
        if (progress.transferredFiles !== null) state.completedFiles = progress.transferredFiles
        if (progress.totalChecks !== null) state.totalFiles = progress.totalChecks
      } else {
        state.currentBytes = progress.bytes ?? state.currentBytes
      }
      const transferred = state.completedBytes + state.currentBytes
      state.job.transferredBytes = transferred
      state.job.transferredFiles = state.completedFiles
      if (progress.speedBytesPerSec !== null) {
        state.job.speed = progress.speedBytesPerSec
        state.lastBytes = transferred
        state.lastSpeedAt = Date.now()
      } else {
        const now = Date.now()
        const elapsed = now - state.lastSpeedAt
        if (elapsed >= 500) {
          state.job.speed = Math.max(
            0,
            Math.round(((transferred - state.lastBytes) * 1000) / elapsed)
          )
          state.lastBytes = transferred
          state.lastSpeedAt = now
        }
      }
      if (state.totalFiles && state.totalFiles > 0) {
        const done =
          state.completedFiles + (progress.finished ? 0 : (progress.percent ?? 0) / 100)
        state.job.percent = Math.max(0, Math.min(99, Math.round((done / state.totalFiles) * 100)))
      }
      return
    }
    if (progress.bytes !== null) state.job.transferredBytes = progress.bytes
    if (progress.toCheck !== null && progress.totalChecks) {
      state.job.percent = Math.round(
        ((progress.totalChecks - progress.toCheck) / progress.totalChecks) * 100
      )
    }
    if (progress.speedBytesPerSec !== null) state.job.speed = progress.speedBytesPerSec
    if (progress.transferredFiles !== null) state.job.transferredFiles = progress.transferredFiles
  }

  private appendLog(sink: string[], line: string): void {
    for (const part of line.split('\n')) {
      const trimmed = part.replace(/\r/g, '')
      if (trimmed) sink.push(trimmed)
    }
    if (sink.length > LOG_MAX_LINES) sink.splice(0, sink.length - LOG_MAX_LINES)
  }

  private emit(state: SyncState): void {
    state.lastEmit = Date.now()
    this.getWebContents()?.send(IPC.evtSyncUpdate, { ...state.job })
  }

  cancel(id: string): void {
    const state = this.jobs.get(id)
    if (!state || state.job.status !== 'running') return
    state.cancelled = true
    const pid = state.child?.pid
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        state.child?.kill('SIGTERM')
      }
      state.forceKillTimer = setTimeout(() => {
        try {
          if (pid) process.kill(-pid, 'SIGKILL')
        } catch {
          /* 进程已退出 */
        }
      }, KILL_GRACE_MS)
    } else {
      state.job.status = 'cancelled'
      state.job.finishedAt = Date.now()
      this.emit(state)
    }
  }

  getLog(id: string): string {
    const state = this.jobs.get(id)
    if (!state) return ''
    return state.logLines.join('\n')
  }

  async killAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((state) => state.job.status === 'running')
    for (const state of running) this.cancel(state.job.id)
    if (running.length === 0) return
    await Promise.all(
      running.map((state) =>
        Promise.race([
          state.closed,
          new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS))
        ])
      )
    )
  }

  private async cleanupTemp(state: SyncState): Promise<void> {
    if (!state.tempDir) return
    await fs.rm(state.tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
