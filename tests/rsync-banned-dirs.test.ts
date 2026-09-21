import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SessionManager } from '../src/main/sftp/manager'
import type { RsyncInfo } from '../src/main/rsync/detect'
import type { SyncStartRequest } from '@shared/types'
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

let localDir = ''

function makeManager(): {
  manager: RsyncManager
  session: { mkdirp: ReturnType<typeof vi.fn> }
} {
  const session = {
    params: { host: '10.0.0.2', port: 22, username: 'root' },
    hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest',
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 1 })),
    resolvePath: vi.fn(async (input: string) => {
      if (input === '~') return '/root'
      if (input.startsWith('~/')) return `/root/${input.slice(2)}`
      return input
    }),
    stat: vi.fn(async () => ({ isDirectory: () => false })),
    mkdirp: vi.fn(async () => undefined)
  }
  const sessions = { get: () => session } as unknown as SessionManager
  const manager = new RsyncManager(
    () => ({ send: () => undefined }) as unknown as WebContents,
    sessions
  )
  ;(manager as unknown as { info: RsyncInfo }).info = RSYNC_INFO
  return { manager, session }
}

const BASE: SyncStartRequest = {
  sessionId: 's1',
  direction: 'upload',
  localPath: '',
  remotePath: '/mnt/pfs/code/sunqy/fpolicy'
}

describe('RsyncManager 禁用同步目录', () => {
  beforeAll(async () => {
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-banned-'))
  })

  afterAll(async () => {
    await fs.rm(localDir, { recursive: true, force: true })
  })

  it('本地目录命中即拒绝启动，且不创建远程目录', async () => {
    const { manager, session } = makeManager()
    await expect(
      manager.start({ ...BASE, localPath: localDir, bannedDirs: [`${localDir}/`] })
    ).rejects.toThrow(`本地目录已被禁用同步: ${localDir}/`)
    expect(session.mkdirp).not.toHaveBeenCalled()
  })

  it('远程目录命中即拒绝启动', async () => {
    const { manager, session } = makeManager()
    await expect(
      manager.start({
        ...BASE,
        localPath: localDir,
        remotePath: '/mnt/pfs/code/sunqy',
        bannedDirs: ['/mnt/pfs/code/sunqy/']
      })
    ).rejects.toThrow('远程目录已被禁用同步: /mnt/pfs/code/sunqy/')
    expect(session.mkdirp).not.toHaveBeenCalled()
  })

  it('下载方向命中远程源目录时拒绝启动，且不创建本地目标目录', async () => {
    const { manager, session } = makeManager()
    const target = path.join(os.tmpdir(), `filetrans-banned-target-${Date.now()}`)
    await expect(
      manager.start({
        ...BASE,
        direction: 'download',
        localPath: target,
        bannedDirs: ['/mnt/pfs/code/sunqy/fpolicy']
      })
    ).rejects.toThrow('远程目录已被禁用同步: /mnt/pfs/code/sunqy/fpolicy')
    expect(session.mkdirp).not.toHaveBeenCalled()
    await expect(fs.stat(target)).rejects.toThrow()
  })

  it('~ 形式的远程目录在解析后命中', async () => {
    const { manager } = makeManager()
    await expect(
      manager.start({
        ...BASE,
        localPath: localDir,
        remotePath: '~/repos',
        bannedDirs: ['/root/repos/']
      })
    ).rejects.toThrow('远程目录已被禁用同步: /root/repos/')
  })

  it('禁用列表之外的子目录不受影响，继续走原有校验', async () => {
    const { manager } = makeManager()
    await expect(
      manager.start({ ...BASE, localPath: localDir, bannedDirs: ['/mnt/pfs/code'] })
    ).rejects.toThrow('远程目标不是目录: /mnt/pfs/code/sunqy/fpolicy')
  })

  it('未配置禁用列表时行为不变', async () => {
    const { manager } = makeManager()
    await expect(manager.start({ ...BASE, localPath: localDir })).rejects.toThrow(
      '远程目标不是目录: /mnt/pfs/code/sunqy/fpolicy'
    )
    await expect(
      manager.start({ ...BASE, localPath: localDir, bannedDirs: [] })
    ).rejects.toThrow('远程目标不是目录: /mnt/pfs/code/sunqy/fpolicy')
  })
})
