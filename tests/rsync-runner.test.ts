import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { SessionManager } from '../src/main/sftp/manager'
import type { RsyncInfo } from '../src/main/rsync/detect'
import type { SyncJob, SyncStartRequest } from '@shared/types'
import { RsyncManager } from '../src/main/rsync/runner'

const RSYNC_INFO: RsyncInfo = {
  path: '/usr/bin/rsync',
  dialect: 'gnu',
  version: '3.2.7',
  modern: true,
  argProtected: true,
  zstd: true,
  label: 'rsync 3.2.7'
}

function hostKeyBlob(): Buffer {
  const type = Buffer.from('ssh-ed25519')
  const key = Buffer.alloc(32, 1)
  const blob = Buffer.alloc(8 + type.length + key.length)
  blob.writeUInt32BE(type.length, 0)
  type.copy(blob, 4)
  blob.writeUInt32BE(key.length, 4 + type.length)
  key.copy(blob, 8 + type.length)
  return blob
}

interface LaunchedState {
  job: SyncJob
  tempDir: string | null
  dialect: 'gnu' | 'openrsync'
  logLines: string[]
}

let workDir = ''
let launched: LaunchedState[] = []
let createdTempDirs: string[] = []

function makeManager(options: {
  privateKeyPath?: string
  info?: RsyncInfo
  mockLaunch?: boolean
} = {}): { manager: RsyncManager; updates: SyncJob[] } {
  const session = {
    params: { host: '10.0.0.2', port: 22, username: 'root', privateKeyPath: options.privateKeyPath },
    hostKey: hostKeyBlob(),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 1 })),
    resolvePath: vi.fn(async (input: string) => input),
    stat: vi.fn(async () => ({ isDirectory: () => true })),
    mkdirp: vi.fn(async () => undefined)
  }
  const updates: SyncJob[] = []
  const sessions = { get: () => session } as unknown as SessionManager
  const manager = new RsyncManager(
    () =>
      ({
        send: (channel: string, payload: unknown) => {
          if (channel === IPC.evtSyncUpdate) updates.push(payload as SyncJob)
        }
      }) as unknown as WebContents,
    sessions
  )
  ;(manager as unknown as { info: RsyncInfo }).info = options.info ?? RSYNC_INFO
  const internal = manager as unknown as {
    launch: (state: LaunchedState) => void
    jobs: Map<string, LaunchedState>
  }
  if (options.mockLaunch ?? true) {
    vi.spyOn(internal, 'launch').mockImplementation((state: LaunchedState) => {
      launched.push(state)
    })
  }
  return { manager, updates }
}

function request(localPath: string): SyncStartRequest {
  return {
    sessionId: 's1',
    direction: 'upload',
    localPath,
    remotePath: '/srv/data'
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-runner-'))
  launched = []
  createdTempDirs = []
})

afterEach(async () => {
  for (const state of launched) {
    if (state.tempDir) await fs.rm(state.tempDir, { recursive: true, force: true })
  }
  for (const dir of createdTempDirs) await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('RsyncManager 私钥副本', () => {
  it('私钥复制到临时目录并设为 0600，ssh 配置指向副本', async () => {
    const keyFile = path.join(workDir, 'id_ed25519')
    await fs.writeFile(keyFile, 'PRIVATE KEY CONTENT', { mode: 0o644 })
    const localDir = path.join(workDir, 'src')
    await fs.mkdir(localDir)

    await makeManager({ privateKeyPath: keyFile }).manager.start(request(localDir))

    expect(launched).toHaveLength(1)
    const tempDir = launched[0].tempDir ?? ''
    const copy = path.join(tempDir, 'identity_key')
    expect(await fs.readFile(copy, 'utf8')).toBe('PRIVATE KEY CONTENT')
    expect((await fs.stat(copy)).mode & 0o777).toBe(0o600)
    const config = await fs.readFile(path.join(tempDir, 'ssh_config'), 'utf8')
    expect(config).toContain(`IdentityFile "${copy}"`)
    expect(config).toContain('PreferredAuthentications publickey')
  })

  it('私钥不可读时报中文错误，且释放目录对锁', async () => {
    const localDir = path.join(workDir, 'src')
    await fs.mkdir(localDir)
    const missing = path.join(workDir, 'missing_key')
    const { manager } = makeManager({ privateKeyPath: missing })

    await expect(manager.start(request(localDir))).rejects.toThrow(`无法读取私钥文件 ${missing}`)
    expect(launched).toHaveLength(0)

    await fs.writeFile(missing, 'PRIVATE KEY CONTENT', { mode: 0o600 })
    await expect(manager.start(request(localDir))).resolves.toEqual(expect.any(String))
    expect(launched).toHaveLength(1)
  })
})

describe('RsyncManager 目录对互斥', () => {
  it('同一目录对并发启动时只有一个能进入', async () => {
    const localDir = path.join(workDir, 'src')
    await fs.mkdir(localDir)
    const { manager } = makeManager()

    const results = await Promise.allSettled([
      manager.start(request(localDir)),
      manager.start(request(localDir))
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect((rejected as PromiseRejectedResult).reason.message).toContain('该目录对已有同步任务正在运行')
    expect(launched).toHaveLength(1)
  })

  it('rsync 进程无法启动时任务结束为失败，清理临时目录并释放锁', async () => {
    const localDir = path.join(workDir, 'src')
    await fs.mkdir(localDir)
    const { manager, updates } = makeManager({
      info: { ...RSYNC_INFO, path: '/usr/bin/rsync\0broken' },
      mockLaunch: false
    })

    const id = await manager.start(request(localDir))
    await waitFor(() => updates.some((job) => job.id === id && job.status === 'error'))
    const failed = [...updates].reverse().find((job) => job.id === id)
    expect(failed?.error).toContain('rsync 启动失败')
    const state = (manager as unknown as { jobs: Map<string, LaunchedState> }).jobs.get(id)
    const tempDir = state?.tempDir ?? ''
    await waitFor(() => {
      try {
        statSync(tempDir)
        return false
      } catch {
        return true
      }
    })

    const second = await manager.start(request(localDir))
    const secondState = (manager as unknown as { jobs: Map<string, LaunchedState> }).jobs.get(second)
    if (secondState?.tempDir) createdTempDirs.push(secondState.tempDir)
    expect(second).not.toBe(id)
  })
})

describe('RsyncManager 旧式进度', () => {
  async function startedState(dialect: 'gnu' | 'openrsync'): Promise<{
    manager: RsyncManager
    state: LaunchedState
    feed: (text: string) => void
  }> {
    const localDir = path.join(workDir, `src-${dialect}`)
    await fs.mkdir(localDir)
    const { manager } = makeManager()
    await manager.start(request(localDir))
    const state = launched[launched.length - 1]
    state.dialect = dialect
    const feed = (text: string): void => {
      ;(manager as unknown as {
        consume: (state: LaunchedState, text: string, sink: string[]) => void
      }).consume(state, text, state.logLines)
    }
    return { manager, state, feed }
  }

  it('GNU --progress 模式下字节数跨文件累加，百分比按已检查文件数计算', async () => {
    const { state, feed } = await startedState('gnu')
    feed('a.bin\n      32768  50%   31.25MB/s    0:00:00\r')
    expect(state.job.transferredBytes).toBe(32768)
    feed('      65536 100%   31.25MB/s    0:00:00 (xfr#1, to-chk=2/4)\n')
    expect(state.job.transferredBytes).toBe(65536)
    expect(state.job.percent).toBe(50)
    feed('b.bin\n     100000 100%   10.00MB/s    0:00:00 (xfr#2, to-chk=1/4)\n')
    expect(state.job.transferredBytes).toBe(165536)
    expect(state.job.transferredFiles).toBe(2)
    expect(state.job.percent).toBe(75)
  })

  it('GNU 2.6.9 旧格式（xfer#/to-check）同样能推进进度', async () => {
    const { state, feed } = await startedState('gnu')
    feed('      32768 100%   31.25MB/s    0:00:00 (xfer#1, to-check=3/5)\n')
    expect(state.job.transferredFiles).toBe(1)
    expect(state.job.percent).toBe(40)
  })

  it('openrsync 增量同步时百分比按已检查文件数而非已传文件数计算', async () => {
    const { state, feed } = await startedState('openrsync')
    feed('       25165824 100%   25.17MB/s   00:00:12 (xfer#1, to-check=1/5)\n')
    expect(state.job.transferredFiles).toBe(1)
    expect(state.job.percent).toBe(80)
  })
})
