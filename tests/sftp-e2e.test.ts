import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { typeFromMode } from '@shared/format'
import { IPC } from '@shared/ipc'
import type {
  ConflictPrompt,
  ConflictResolution,
  HostKeyPrompt,
  TransferGroup,
  TransferStartRequest
} from '@shared/types'

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
import { TransferManager } from '../src/main/sftp/transfer'
import type { SftpSession } from '../src/main/sftp/session'

const port = Number(process.env.FILETRANS_TEST_SSH_PORT ?? 0)
const keyPath = process.env.FILETRANS_TEST_SSH_KEY ?? ''
const username = process.env.FILETRANS_TEST_SSH_USER ?? os.userInfo().username
const enabled = port > 0 && Boolean(keyPath)

const runId = `filetrans-e2e-${Date.now()}-${Math.floor(Math.random() * 100000)}`
const remoteBase = `/tmp/${runId}`
const remoteTree = `${remoteBase}/tree`

let tempLocal = ''
const updates: TransferGroup[] = []
let conflictChoice: ConflictResolution = 'overwrite'

const describeMaybe = enabled ? describe : describe.skip

describeMaybe('SFTP 集成: 跟随并重映射 symlink', () => {
  const send = (channel: string, payload: unknown): void => {
    if (channel === IPC.evtHostKeyPrompt) {
      const prompt = payload as HostKeyPrompt
      setTimeout(() => sessions.respondHostKey(prompt.promptId, true, true), 0)
    } else if (channel === IPC.evtTransferUpdate) {
      updates.push(payload as TransferGroup)
    } else if (channel === IPC.evtConflictPrompt) {
      const prompt = payload as ConflictPrompt
      setTimeout(() => transfers.resolveConflict(prompt.transferId, conflictChoice), 0)
    }
  }
  const fakeWebContents = { send } as unknown as WebContents
  const sessions = new SessionManager(() => fakeWebContents)
  const transfers = new TransferManager(() => fakeWebContents, sessions)
  let session: SftpSession
  let sessionId = ''

  const runTransfer = async (req: TransferStartRequest): Promise<TransferGroup> => {
    const id = await transfers.start(req)
    return await new Promise<TransferGroup>((resolve, reject) => {
      const check = (): void => {
        const group = [...updates].reverse().find((item) => item.id === id)
        if (group?.status === 'done') {
          resolve(group)
          return
        }
        if (group && group.status !== 'active' && group.status !== 'pending' && group.status !== 'paused') {
          reject(new Error(group.error ?? group.status))
          return
        }
        setTimeout(check, 50)
      }
      check()
    })
  }

  const readRemote = (target: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = session.createReadStream(target)
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })

  afterAll(async () => {
    await session?.removeEntries([remoteBase]).catch(() => undefined)
    await sessions.disconnect(sessionId).catch(() => undefined)
    if (tempLocal) await fs.rm(tempLocal, { recursive: true, force: true })
  })

  it('上传/下载时按同步范围重映射链接', async () => {
    tempLocal = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-src-'))
    const uploadRoot = path.join(tempLocal, 'tree')
    const externalDir = path.join(tempLocal, 'external-dir')
    const externalFile = path.join(tempLocal, 'external.txt')

    await fs.mkdir(path.join(uploadRoot, 'filesonly'), { recursive: true })
    await fs.mkdir(path.join(uploadRoot, 'real'), { recursive: true })
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(path.join(uploadRoot, 'filesonly', 'only.txt'), 'only')
    await fs.writeFile(path.join(uploadRoot, 'real', 'target.txt'), 'target-content')
    await fs.chmod(path.join(uploadRoot, 'real', 'target.txt'), 0o640)
    const stamp = new Date('2024-05-06T07:08:09Z')
    await fs.utimes(path.join(uploadRoot, 'real', 'target.txt'), stamp, stamp)
    await fs.writeFile(path.join(externalDir, 'inner.txt'), 'inner')
    await fs.writeFile(externalFile, 'external-content')

    await fs.symlink('target.txt', path.join(uploadRoot, 'real', 'link-rel.txt'))
    await fs.symlink('real/target.txt', path.join(uploadRoot, 'top-link.txt'))
    await fs.symlink(
      path.join(uploadRoot, 'real', 'target.txt'),
      path.join(uploadRoot, 'abs-link.txt')
    )
    await fs.symlink('real', path.join(uploadRoot, 'dirlink'))
    await fs.symlink(path.join(tempLocal, 'missing.txt'), path.join(uploadRoot, 'dangling.txt'))
    await fs.symlink(externalFile, path.join(uploadRoot, 'ext-link.txt'))
    await fs.symlink(externalDir, path.join(uploadRoot, 'ext-dirlink'))

    const info = await sessions.connect({
      host: '127.0.0.1',
      port,
      username,
      privateKeyPath: keyPath
    })
    expect(info.username).toBe(username)
    sessionId = info.sessionId
    session = sessions.get(info.sessionId)

    const upload = await runTransfer({
      sessionId,
      direction: 'upload',
      sources: [uploadRoot],
      targetDir: remoteBase,
      recursive: true
    })
    expect(upload.status).toBe('done')

    expect(await session.readlink(`${remoteTree}/top-link.txt`)).toBe('real/target.txt')
    expect(await session.readlink(`${remoteTree}/real/link-rel.txt`)).toBe('target.txt')
    expect(await session.readlink(`${remoteTree}/abs-link.txt`)).toBe(`${remoteTree}/real/target.txt`)
    expect(await session.readlink(`${remoteTree}/dirlink`)).toBe('real')

    const extStat = await session.lstat(`${remoteTree}/ext-link.txt`)
    expect(typeFromMode(extStat.mode)).toBe('file')
    expect(await readRemote(`${remoteTree}/ext-link.txt`)).toBe('external-content')

    const extDirStat = await session.lstat(`${remoteTree}/ext-dirlink`)
    expect(typeFromMode(extDirStat.mode)).toBe('directory')
    const extDirListing = await session.list(`${remoteTree}/ext-dirlink`)
    expect(extDirListing.entries.map((entry) => entry.name)).toContain('inner.txt')

    const danglingStat = await session.lstat(`${remoteTree}/dangling.txt`)
    expect(typeFromMode(danglingStat.mode)).toBe('symlink')
    expect(await session.readlink(`${remoteTree}/dangling.txt`)).toBe(
      path.join(tempLocal, 'missing.txt')
    )

    const onlyStat = await session.lstat(`${remoteTree}/filesonly/only.txt`)
    expect(typeFromMode(onlyStat.mode)).toBe('file')

    const remoteTargetStat = await session.lstat(`${remoteTree}/real/target.txt`)
    expect(remoteTargetStat.mode & 0o777).toBe(0o640)
    expect(remoteTargetStat.mtime).toBe(Math.floor(stamp.getTime() / 1000))

    const downloadBase = path.join(tempLocal, 'download')
    const download = await runTransfer({
      sessionId,
      direction: 'download',
      sources: [remoteTree],
      targetDir: downloadBase,
      recursive: true
    })
    expect(download.status).toBe('done')

    const downloaded = path.join(downloadBase, 'tree')
    expect(await fs.readlink(path.join(downloaded, 'top-link.txt'))).toBe('real/target.txt')
    expect(await fs.readlink(path.join(downloaded, 'real/link-rel.txt'))).toBe('target.txt')
    expect(await fs.readlink(path.join(downloaded, 'abs-link.txt'))).toBe(
      path.join(downloaded, 'real', 'target.txt')
    )
    expect(await fs.readlink(path.join(downloaded, 'dirlink'))).toBe('real')
    expect(await fs.readFile(path.join(downloaded, 'real', 'target.txt'), 'utf8')).toBe(
      'target-content'
    )

    const downloadedExt = await fs.lstat(path.join(downloaded, 'ext-link.txt'))
    expect(downloadedExt.isSymbolicLink()).toBe(false)
    expect(downloadedExt.isFile()).toBe(true)
    expect(await fs.readFile(path.join(downloaded, 'ext-link.txt'), 'utf8')).toBe(
      'external-content'
    )

    const downloadedExtDir = await fs.lstat(path.join(downloaded, 'ext-dirlink'))
    expect(downloadedExtDir.isDirectory()).toBe(true)
    expect((await fs.stat(path.join(downloaded, 'ext-dirlink', 'inner.txt'))).isFile()).toBe(true)

    const downloadedDangling = await fs.lstat(path.join(downloaded, 'dangling.txt'))
    expect(downloadedDangling.isSymbolicLink()).toBe(true)
    expect(await fs.readlink(path.join(downloaded, 'dangling.txt'))).toBe(
      path.join(tempLocal, 'missing.txt')
    )

    expect((await fs.stat(path.join(downloaded, 'filesonly', 'only.txt'))).isFile()).toBe(true)

    const downloadedTargetStat = await fs.stat(path.join(downloaded, 'real', 'target.txt'))
    expect(downloadedTargetStat.mode & 0o777).toBe(0o640)
    expect(Math.round(downloadedTargetStat.mtimeMs / 1000)).toBe(
      Math.floor(stamp.getTime() / 1000)
    )

    const reupload = await runTransfer({
      sessionId,
      direction: 'upload',
      sources: [uploadRoot],
      targetDir: remoteBase,
      recursive: true
    })
    expect(reupload.status).toBe('done')
    expect(await session.readlink(`${remoteTree}/top-link.txt`)).toBe('real/target.txt')

    const partial = await readRemote(`${remoteTree}/real/target.txt`)
    await new Promise<void>((resolve, reject) => {
      const stream = session.createWriteStream(`${remoteTree}/real/target.txt`, 'w')
      stream.on('close', () => resolve())
      stream.on('error', reject)
      stream.end(partial.slice(0, 7))
    })
    conflictChoice = 'resume'
    const resumed = await runTransfer({
      sessionId,
      direction: 'upload',
      sources: [uploadRoot],
      targetDir: remoteBase,
      recursive: true
    })
    conflictChoice = 'overwrite'
    expect(resumed.status).toBe('done')
    expect(await readRemote(`${remoteTree}/real/target.txt`)).toBe('target-content')
    const resumedStat = await session.lstat(`${remoteTree}/real/target.txt`)
    expect(resumedStat.mtime).toBe(Math.floor(stamp.getTime() / 1000))
  }, 120000)
})
