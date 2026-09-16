import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { HostKeyPrompt, SyncJob } from '@shared/types'

vi.mock('electron', async () => {
  const nodeOs = await import('node:os')
  const nodePath = await import('node:path')
  const dataDir =
    process.env.FILETRANS_TEST_DATA ?? nodePath.join(nodeOs.tmpdir(), 'filetrans-test-data')
  return {
    app: { getPath: () => dataDir },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (buffer: Buffer) => buffer.toString('utf8')
    }
  }
})

import { SessionManager } from '../src/main/sftp/manager'
import { probeRsyncPath, type RsyncInfo } from '../src/main/rsync/detect'
import { RsyncManager } from '../src/main/rsync/runner'

const port = Number(process.env.FILETRANS_TEST_SSH_PORT ?? 0)
const keyPath = process.env.FILETRANS_TEST_SSH_KEY ?? ''
const username = process.env.FILETRANS_TEST_SSH_USER ?? os.userInfo().username
const forcedRsyncPath = process.env.FILETRANS_TEST_RSYNC_PATH ?? ''
const enabled = port > 0 && Boolean(keyPath)

const runId = `filetrans-sync-e2e-${Date.now()}`
const remoteBase = `/tmp/${runId}`

let tempLocal = ''
const updates: SyncJob[] = []

const describeMaybe = enabled ? describe : describe.skip

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 30000,
  message = 'waitFor 超时'
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function latestJob(id: string): SyncJob | undefined {
  return [...updates].reverse().find((job) => job.id === id)
}

describeMaybe('rsync 同步集成', () => {
  const send = (channel: string, payload: unknown): void => {
    if (channel === IPC.evtHostKeyPrompt) {
      const prompt = payload as HostKeyPrompt
      setTimeout(() => sessions.respondHostKey(prompt.promptId, true, true), 0)
    } else if (channel === IPC.evtSyncUpdate) {
      updates.push(payload as SyncJob)
    }
  }
  const fakeWebContents = { send } as unknown as WebContents
  const sessions = new SessionManager(() => fakeWebContents)
  const syncs = new RsyncManager(() => fakeWebContents, sessions)
  let sessionId = ''

  beforeAll(async () => {
    if (!forcedRsyncPath) return
    const info = await probeRsyncPath(forcedRsyncPath)
    if (!info) throw new Error(`无法识别 rsync: ${forcedRsyncPath}`)
    ;(syncs as unknown as { info: RsyncInfo }).info = info
  })

  const runSync = async (
    req: Parameters<typeof syncs.start>[0]
  ): Promise<SyncJob> => {
    const id = await syncs.start(req)
    await waitFor(() => {
      const job = latestJob(id)
      return job !== undefined && job.status !== 'running'
    })
    const job = latestJob(id)
    if (!job) throw new Error('同步任务未产生更新')
    if (job.status === 'error') {
      console.error(syncs.getLog(id))
      throw new Error(job.error ?? '同步失败')
    }
    return job
  }

  afterAll(async () => {
    if (sessionId) {
      await sessions.disconnect(sessionId).catch(() => undefined)
    }
    if (tempLocal) await fs.rm(tempLocal, { recursive: true, force: true }).catch(() => undefined)
  })

  it('上传同步：内容镜像 + 排除规则', async () => {
    const connected = await sessions.connect({
      host: '127.0.0.1',
      port,
      username,
      privateKeyPath: keyPath
    })
    sessionId = connected.sessionId
    tempLocal = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-sync-local-'))
    const src = path.join(tempLocal, 'src')
    await fs.mkdir(path.join(src, 'sub'), { recursive: true })
    await fs.writeFile(path.join(src, 'a.txt'), 'alpha')
    await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'beta')
    await fs.mkdir(path.join(src, '.venv-dir'), { recursive: true })
    await fs.writeFile(path.join(src, '.venv-dir', 'skip.txt'), 'skipped')

    const job = await runSync({
      sessionId,
      direction: 'upload',
      localPath: src,
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'], compress: true }
    })
    expect(job.status).toBe('done')
    expect(job.transferredFiles).toBeGreaterThanOrEqual(2)
    expect(await fs.readFile(path.join(remoteBase, 'dst', 'a.txt'), 'utf8')).toBe('alpha')
    expect(await fs.readFile(path.join(remoteBase, 'dst', 'sub', 'b.txt'), 'utf8')).toBe('beta')
    const dstList = await fs.readdir(path.join(remoteBase, 'dst'))
    expect(dstList.some((name) => name.startsWith('.venv'))).toBe(false)
  })

  it('二次运行跳过未变化文件', async () => {
    const job = await runSync({
      sessionId,
      direction: 'upload',
      localPath: path.join(tempLocal, 'src'),
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'] }
    })
    expect(job.status).toBe('done')
    expect(job.transferredFiles).toBe(0)
  })

  it('内容变化后重新传输', async () => {
    await fs.writeFile(path.join(tempLocal, 'src', 'a.txt'), 'alpha-v2')
    const job = await runSync({
      sessionId,
      direction: 'upload',
      localPath: path.join(tempLocal, 'src'),
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'] }
    })
    expect(job.status).toBe('done')
    expect(job.transferredFiles).toBeGreaterThanOrEqual(1)
    expect(await fs.readFile(path.join(remoteBase, 'dst', 'a.txt'), 'utf8')).toBe('alpha-v2')
  })

  it('默认不删除目标端多余文件，开启后镜像删除', async () => {
    await fs.unlink(path.join(tempLocal, 'src', 'a.txt'))
    const keepJob = await runSync({
      sessionId,
      direction: 'upload',
      localPath: path.join(tempLocal, 'src'),
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'] }
    })
    expect(keepJob.status).toBe('done')
    expect(await fs.access(path.join(remoteBase, 'dst', 'a.txt')).then(() => true, () => false)).toBe(
      true
    )

    const deleteJob = await runSync({
      sessionId,
      direction: 'upload',
      localPath: path.join(tempLocal, 'src'),
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'], deleteExtraneous: true }
    })
    expect(deleteJob.status).toBe('done')
    expect(await fs.access(path.join(remoteBase, 'dst', 'a.txt')).then(() => true, () => false)).toBe(
      false
    )
    expect(await fs.access(path.join(remoteBase, 'dst', 'sub', 'b.txt')).then(() => true, () => false)).toBe(
      true
    )
  })

  it('下载同步：远程镜像到本地', async () => {
    const localDst = path.join(tempLocal, 'downloaded')
    const job = await runSync({
      sessionId,
      direction: 'download',
      localPath: localDst,
      remotePath: `${remoteBase}/dst`,
      options: { exclude: ['.venv*'] }
    })
    expect(job.status).toBe('done')
    expect(await fs.readFile(path.join(localDst, 'sub', 'b.txt'), 'utf8')).toBe('beta')
  })
})
