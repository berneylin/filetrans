import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { ConflictPrompt, ConflictResolution, TransferGroup } from '@shared/types'
import type { SessionManager } from '../src/main/sftp/manager'
import {
  PARALLEL_MIN_BYTES,
  PARALLEL_MIN_SEGMENT,
  planParallelSegments,
  resolveResumeOffset,
  TransferManager
} from '../src/main/sftp/transfer'

function fsSyncExists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch {
    return false
  }
}

class FakeWriteStream extends Writable {
  private buffer: Buffer

  constructor(
    private remote: FakeSession,
    private target: string,
    flags: 'w' | 'a'
  ) {
    super()
    this.buffer =
      flags === 'a' ? Buffer.from(remote.files.get(target) ?? Buffer.alloc(0)) : Buffer.alloc(0)
    remote.files.set(target, this.buffer)
  }

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    setTimeout(() => {
      if (this.destroyed) {
        callback()
        return
      }
      const { remote } = this
      if (
        remote.failNextWriteAfter !== null &&
        this.buffer.length + chunk.length > remote.failNextWriteAfter
      ) {
        const allowed = remote.failNextWriteAfter - this.buffer.length
        if (allowed > 0) {
          remote.writeLog.push({ path: this.target, offset: this.buffer.length, length: allowed })
          this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, allowed)])
        }
        remote.files.set(this.target, this.buffer)
        remote.failNextWriteAfter = null
        callback(new Error('模拟网络中断'))
        return
      }
      remote.writeLog.push({ path: this.target, offset: this.buffer.length, length: chunk.length })
      this.buffer = Buffer.concat([this.buffer, chunk])
      remote.files.set(this.target, this.buffer)
      callback()
    }, this.remote.writeDelayMs)
  }
}

interface FakeStats {
  mode: number
  size: number
  atime: number
  mtime: number
}

class FakeSession {
  files = new Map<string, Buffer>()
  dirs = new Set<string>()
  links = new Map<string, string>()
  chmodCalls: Array<{ path: string; mode: number }> = []
  utimesCalls: Array<{ path: string; atime: number; mtime: number }> = []
  writeLog: Array<{ path: string; offset: number; length: number }> = []
  readLog: Array<{ path: string; start: number; end: number }> = []
  failNextWriteAfter: number | null = null
  writeDelayMs = 0
  readDelayMs = 0
  activeReads = 0
  maxActiveReads = 0

  private entryStats(target: string): FakeStats {
    const file = this.files.get(target)
    if (file) return { mode: 0o100640, size: file.length, atime: 1700000000, mtime: 1700000000 }
    if (this.dirs.has(target)) return { mode: 0o040755, size: 0, atime: 1700000000, mtime: 1700000000 }
    throw new Error('No such file')
  }

  async stat(target: string): Promise<FakeStats> {
    return this.entryStats(target)
  }

  async lstat(target: string): Promise<FakeStats> {
    if (this.links.has(target)) return { mode: 0o120777, size: 0, atime: 0, mtime: 0 }
    return this.entryStats(target)
  }

  async exists(target: string): Promise<boolean> {
    return this.files.has(target) || this.dirs.has(target)
  }

  async lexists(target: string): Promise<boolean> {
    return this.files.has(target) || this.dirs.has(target) || this.links.has(target)
  }

  async mkdirp(target: string): Promise<void> {
    const parts = target.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      this.dirs.add(current)
    }
  }

  async removeEntries(targets: string[]): Promise<void> {
    for (const target of targets) {
      const prefix = `${target}/`
      for (const key of [...this.files.keys(), ...this.links.keys(), ...this.dirs]) {
        if (key === target || key.startsWith(prefix)) {
          this.files.delete(key)
          this.links.delete(key)
          this.dirs.delete(key)
        }
      }
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.links.set(linkPath, target)
  }

  async finalizeTransfer(fromPath: string, toPath: string): Promise<void> {
    const data = this.files.get(fromPath)
    if (data !== undefined) {
      this.files.set(toPath, data)
      this.files.delete(fromPath)
      return
    }
    const link = this.links.get(fromPath)
    if (link !== undefined) {
      this.links.set(toPath, link)
      this.links.delete(fromPath)
      return
    }
    throw new Error('No such file')
  }

  async chmodEntry(target: string, mode: number): Promise<void> {
    this.chmodCalls.push({ path: target, mode })
  }

  async utimes(target: string, atime: number, mtime: number): Promise<void> {
    this.utimesCalls.push({ path: target, atime, mtime })
  }

  createWriteStream(target: string, flags: 'w' | 'a' = 'w'): Writable {
    return new FakeWriteStream(this, target, flags)
  }

  createReadStream(
    target: string,
    options?: { start?: number; end?: number; highWaterMark?: number }
  ): Readable {
    const file = this.files.get(target)
    if (!file) throw new Error('No such file')
    const start = options?.start ?? 0
    const end = Math.min(options?.end ?? file.length - 1, file.length - 1)
    const highWaterMark = options?.highWaterMark ?? 64 * 1024
    this.readLog.push({ path: target, start, end })
    this.activeReads++
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads)
    let pos = start
    const stream = new Readable({
      highWaterMark,
      read: () => {
        setTimeout(() => {
          if (stream.destroyed) return
          if (pos > end) {
            stream.push(null)
            return
          }
          const stop = Math.min(end + 1, pos + highWaterMark)
          stream.push(Buffer.from(file.subarray(pos, stop)))
          pos = stop
        }, this.readDelayMs)
      }
    })
    stream.on('close', () => {
      this.activeReads--
    })
    return stream
  }
}

function makeHarness(
  conflictResolution: ConflictResolution = 'overwrite',
  onConflict?: (prompt: ConflictPrompt) => void | Promise<void>
) {
  const fake = new FakeSession()
  const events: TransferGroup[] = []
  let manager: TransferManager
  const webContents = {
    send: (channel: string, payload: unknown) => {
      if (channel === IPC.evtTransferUpdate) {
        events.push(payload as TransferGroup)
      } else if (channel === IPC.evtConflictPrompt) {
        const prompt = payload as ConflictPrompt
        setTimeout(() => {
          void Promise.resolve(onConflict?.(prompt)).then(() =>
            manager.resolveConflict(prompt.transferId, conflictResolution)
          )
        }, 0)
      }
    }
  } as unknown as WebContents
  const sessions = { get: () => fake } as unknown as SessionManager
  manager = new TransferManager(() => webContents, sessions)
  return { fake, events, manager }
}

function latest(events: TransferGroup[], id: string): TransferGroup | undefined {
  return [...events].reverse().find((event) => event.id === id)
}

async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const OFF_ATTRS = { preserveTimestamps: false, preservePermissions: false }

describe('resolveResumeOffset', () => {
  it('目标不存在或更大时从头传输', () => {
    expect(resolveResumeOffset(100, null)).toEqual({ complete: false, offset: 0 })
    expect(resolveResumeOffset(100, 120)).toEqual({ complete: false, offset: 0 })
  })
  it('目标更小时从断点续传', () => {
    expect(resolveResumeOffset(100, 40)).toEqual({ complete: false, offset: 40 })
  })
  it('大小一致视为已完成', () => {
    expect(resolveResumeOffset(100, 100)).toEqual({ complete: true, offset: 100 })
    expect(resolveResumeOffset(0, 0)).toEqual({ complete: true, offset: 0 })
  })
})

describe('planParallelSegments', () => {
  it('按并发数均分剩余区间且覆盖完整', () => {
    const size = 12 * 1024 * 1024
    const segments = planParallelSegments(size, 0, 4)
    expect(segments.length).toBe(3)
    expect(segments[0]).toEqual({ start: 0, end: 4 * 1024 * 1024, written: 0 })
    expect(segments[segments.length - 1].end).toBe(size)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].start).toBe(segments[i - 1].end)
    }
  })
  it('从续传偏移开始切分', () => {
    const segments = planParallelSegments(16 * 1024 * 1024, 4 * 1024 * 1024, 8)
    expect(segments[0].start).toBe(4 * 1024 * 1024)
    expect(segments[segments.length - 1].end).toBe(16 * 1024 * 1024)
  })
  it('剩余不足最小分段时只切一段', () => {
    expect(planParallelSegments(1024 * 1024, 0, 8).length).toBe(1)
    expect(planParallelSegments(1024, 1024, 8)).toEqual([])
  })
})

describe('传输引擎', () => {
  let tempDir = ''
  const target = '/remote/dest/file.bin'
  const partTarget = `${target}${'.filetrans-part'}`

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-engine-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('失败后自动重试并从断点续传，内容一致', async () => {
    const data = randomBytes(128 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness()
    fake.failNextWriteAfter = 40000
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 2, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    expect(events.some((event) => event.id === id && (event.retryCount ?? 0) > 0)).toBe(true)
    expect(fake.writeLog.some((entry) => entry.offset === 40000)).toBe(true)
  })

  it('暂停后从断点恢复，内容一致', async () => {
    const data = randomBytes(1024 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness()
    fake.writeDelayMs = 50
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })

    await waitFor(() => (latest(events, id)?.transferredBytes ?? 0) > 0)
    manager.pause(id)
    await waitFor(() => latest(events, id)?.status === 'paused')
    const pausedActive = latest(events, id)?.activeFiles ?? []
    expect(pausedActive.length).toBe(1)
    expect(pausedActive[0].transferred).toBeGreaterThan(0)
    expect(pausedActive[0].speed).toBe(0)
    const pausedSize = fake.files.get(partTarget)?.length ?? 0
    expect(pausedSize).toBeGreaterThan(0)
    expect(pausedSize).toBeLessThan(data.length)
    expect(fake.files.has(target)).toBe(false)

    manager.resume(id)
    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    expect(fake.files.has(partTarget)).toBe(false)
    expect(fake.writeLog.some((entry) => entry.offset > 0)).toBe(true)
    expect(latest(events, id)?.activeFiles).toEqual([])
  }, 30000)

  it('并发传输时事件包含正在传输文件的进度明细', async () => {
    const dataA = randomBytes(1024 * 1024)
    const dataB = randomBytes(1024 * 1024)
    const sourceA = path.join(tempDir, 'a.bin')
    const sourceB = path.join(tempDir, 'b.bin')
    await fs.writeFile(sourceA, dataA)
    await fs.writeFile(sourceB, dataB)

    const { fake, events, manager } = makeHarness()
    fake.writeDelayMs = 50
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [sourceA, sourceB],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })

    await waitFor(() => {
      const files = latest(events, id)?.activeFiles ?? []
      return files.length === 2 && files.some((file) => file.transferred > 0)
    })
    const active = latest(events, id)?.activeFiles ?? []
    expect(new Set(active.map((file) => file.name))).toEqual(new Set(['a.bin', 'b.bin']))
    expect(active.every((file) => file.size === dataA.length)).toBe(true)
    expect(
      active.every((file) => file.path === sourceA || file.path === sourceB)
    ).toBe(true)
    expect(events.some((event) => event.activeFiles?.some((file) => file.speed > 0))).toBe(true)

    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect(latest(events, id)?.activeFiles).toEqual([])
  }, 30000)

  it('冲突选择续传时只补传剩余部分', async () => {
    const data = randomBytes(64 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(target, Buffer.from(data.subarray(0, 20000)))
    fake.writeLog = []

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    const written = fake.writeLog.reduce((sum, entry) => sum + entry.length, 0)
    expect(written).toBe(data.length - 20000)
    expect(fake.writeLog.every((entry) => entry.offset >= 20000)).toBe(true)
  })

  it('保留修改时间与权限', async () => {
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, 'attributes')
    await fs.chmod(source, 0o640)
    const stamp = new Date('2024-05-06T07:08:09Z')
    await fs.utimes(source, stamp, stamp)

    const { fake, events, manager } = makeHarness()
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, preserveTimestamps: true, preservePermissions: true }
    })
    await waitFor(() => latest(events, id)?.status === 'done')

    expect(fake.chmodCalls).toContainEqual({ path: partTarget, mode: 0o640 })
    expect(fake.files.has(target)).toBe(true)
    expect(fake.files.has(partTarget)).toBe(false)
    expect(fake.utimesCalls.length).toBeGreaterThan(0)
    expect(fake.utimesCalls[0].mtime).toBeCloseTo(stamp.getTime() / 1000, 0)
  })

  it('并行分块下载大文件，内容一致且分段覆盖完整', async () => {
    const size = PARALLEL_MIN_BYTES + PARALLEL_MIN_SEGMENT
    const data = randomBytes(size)
    const remote = '/remote/src/big.bin'
    const local = path.join(tempDir, 'big.bin')

    const { fake, events, manager } = makeHarness()
    fake.files.set(remote, data)
    fake.readDelayMs = 5
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: [remote],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(latest(events, id)?.transferredBytes).toBe(size)

    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fake.readLog.length).toBe(3)
    expect(fake.maxActiveReads).toBeGreaterThanOrEqual(2)
    const ranges = [...fake.readLog].sort((a, b) => a.start - b.start)
    expect(ranges[0].start).toBe(0)
    expect(ranges[ranges.length - 1].end).toBe(size - 1)
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start).toBe(ranges[i - 1].end + 1)
    }
  })

  it('小文件不使用并行分块', async () => {
    const data = randomBytes(1024 * 1024)
    const remote = '/remote/src/small.bin'

    const { fake, events, manager } = makeHarness()
    fake.files.set(remote, data)
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: [remote],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 8, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.readLog.length).toBe(1)
    expect((await fs.readFile(path.join(tempDir, 'small.bin'))).equals(data)).toBe(true)
  })

  it('并行下载暂停后断点续传，内容一致', async () => {
    const size = PARALLEL_MIN_BYTES + 6 * PARALLEL_MIN_SEGMENT
    const data = randomBytes(size)
    const remote = '/remote/src/pause.bin'
    const local = path.join(tempDir, 'pause.bin')

    const { fake, events, manager } = makeHarness()
    fake.files.set(remote, data)
    fake.readDelayMs = 15
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: [remote],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })

    await waitFor(() => {
      try {
        return statSync(`${local}.filetrans-part`).size > 0
      } catch {
        return false
      }
    })
    manager.pause(id)
    await waitFor(() => latest(events, id)?.status === 'paused')
    const pausedSize = statSync(`${local}.filetrans-part`).size
    expect(pausedSize).toBeGreaterThan(0)
    expect(pausedSize).toBeLessThan(size)
    const readsBefore = fake.readLog.length

    manager.resume(id)
    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fsSyncExists(`${local}.filetrans-part`)).toBe(false)
    const resumedReads = fake.readLog.slice(readsBefore)
    expect(resumedReads.length).toBeGreaterThan(0)
    expect(resumedReads.some((entry) => entry.start > 0)).toBe(true)
  }, 30000)

  it('覆盖已存在目录时先递归删除再写入', async () => {
    const data = randomBytes(16 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness('overwrite')
    fake.dirs.add(target)
    fake.files.set(`${target}/old.txt`, Buffer.from('stale'))

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    expect(fake.files.has(`${target}/old.txt`)).toBe(false)
    expect(fake.files.has(partTarget)).toBe(false)
  })

  it('目标为目录且未选择覆盖时报错', async () => {
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, randomBytes(64))

    const { fake, events, manager } = makeHarness('resume')
    fake.dirs.add(target)

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'error')
    expect(latest(events, id)?.error).toContain('目标为目录')
  })

  it('同大小不同内容的旧文件续传校验失败后改为覆盖', async () => {
    const data = randomBytes(64 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(target, randomBytes(data.length))
    fake.writeLog = []

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    expect(fake.files.has(partTarget)).toBe(false)
  })

  it('源文件修改时间变化时禁用续传改为覆盖', async () => {
    const data = randomBytes(64 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness('resume', async () => {
      const stats = await fs.stat(source)
      await fs.utimes(source, stats.atime, new Date(0))
    })
    fake.files.set(target, Buffer.from(data.subarray(0, 20000)))
    fake.writeLog = []

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    const written = fake.writeLog.reduce((sum, entry) => sum + entry.length, 0)
    expect(written).toBe(data.length)
    expect(fake.files.has(partTarget)).toBe(false)
  })

  it('残留临时文件会触发冲突且覆盖时被清理', async () => {
    const data = randomBytes(16 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)

    const { fake, events, manager } = makeHarness('overwrite')
    fake.files.set(partTarget, Buffer.from(data.subarray(0, 4096)))

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get(target)?.equals(data)).toBe(true)
    expect(fake.files.has(partTarget)).toBe(false)
  })

  it('列表接口返回包含 sessionId 的传输组', async () => {
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, randomBytes(1024))

    const { fake, events, manager } = makeHarness()
    fake.files.set(target, Buffer.alloc(0))
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    const groups = manager.list()
    const found = groups.find((group) => group.id === id)
    expect(found?.sessionId).toBe('test-session')
    expect(found?.status).toBe('done')
  })
})
