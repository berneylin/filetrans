import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { typeFromMode } from '@shared/format'
import type { ConflictPrompt, ConflictResolution, DirListing, FileEntry, TransferGroup } from '@shared/types'
import type { SessionManager } from '../src/main/sftp/manager'
import {
  caseFoldCollisions,
  localCaseInsensitive,
  PARALLEL_MIN_BYTES,
  PARALLEL_MIN_SEGMENT,
  planParallelSegments,
  planResumeVerify,
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
  id = 'fake-session'
  params = { host: 'fake-host', port: 22, username: 'tester' }
  connected = true
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
  readDelays = new Map<number, number>()
  failNextReadAfter: number | null = null
  activeReads = 0
  maxActiveReads = 0
  listDelayMs = 0
  activeLists = 0
  maxActiveLists = 0
  failSymlinkFor: string[] = []

  private entryStats(target: string): FakeStats {
    const file = this.files.get(target)
    if (file) return { mode: 0o100640, size: file.length, atime: 1700000000, mtime: 1700000000 }
    if (this.dirs.has(target)) return { mode: 0o040755, size: 0, atime: 1700000000, mtime: 1700000000 }
    throw new Error('No such file')
  }

  async stat(target: string): Promise<FakeStats> {
    return this.entryStats(target)
  }

  async realpath(target: string): Promise<string> {
    return target
  }

  async readlink(target: string): Promise<string> {
    const link = this.links.get(target)
    if (link === undefined) throw new Error('No such file')
    return link
  }

  list(target: string): Promise<DirListing> {
    this.activeLists++
    this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists)
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        this.activeLists--
        if (!this.dirs.has(target)) {
          reject(new Error('No such file'))
          return
        }
        const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/'))
        const entry = (key: string, mode: number, size: number): FileEntry => ({
          name: key.slice(key.lastIndexOf('/') + 1),
          path: key,
          type: typeFromMode(mode),
          size,
          mtime: 1700000000000,
          atime: 1700000000000,
          mode,
          isSymlink: typeFromMode(mode) === 'symlink'
        })
        const entries: FileEntry[] = []
        for (const [key, buf] of this.files) {
          if (parentOf(key) === target) entries.push(entry(key, 0o100640, buf.length))
        }
        for (const key of this.links.keys()) {
          if (parentOf(key) === target) entries.push(entry(key, 0o120777, 0))
        }
        for (const key of this.dirs) {
          if (key !== target && parentOf(key) === target) entries.push(entry(key, 0o040755, 0))
        }
        resolve({ path: target, parent: parentOf(target), entries })
      }, this.listDelayMs)
    })
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
    if (this.failSymlinkFor.includes(linkPath)) {
      throw new Error('模拟远端拒绝创建符号链接')
    }
    this.links.set(linkPath, target)
  }

  async finalizeTransfer(fromPath: string, toPath: string): Promise<void> {
    const data = this.files.get(fromPath)
    if (data !== undefined) {
      await this.removeEntries([toPath])
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
          if (this.failNextReadAfter !== null && pos - start >= this.failNextReadAfter) {
            this.failNextReadAfter = null
            stream.destroy(new Error('模拟网络中断'))
            return
          }
          if (pos > end) {
            stream.push(null)
            return
          }
          const stop = Math.min(end + 1, pos + highWaterMark)
          stream.push(Buffer.from(file.subarray(pos, stop)))
          pos = stop
        }, this.readDelays.get(start) ?? this.readDelayMs)
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

describe('大小写冲突检测', () => {
  it('按 NFC 与小写折叠找出冲突项，保留先出现的路径', () => {
    const collisions = caseFoldCollisions([
      '/d/README',
      '/d/readme',
      '/d/b',
      '/d/Caf\u00e9',
      '/d/cafe\u0301'
    ])
    expect([...collisions.entries()]).toEqual([
      [1, '/d/README'],
      [4, '/d/Caf\u00e9']
    ])
  })

  it('探测结果与文件系统实际行为一致，且不留下探测文件', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-case-'))
    try {
      await fs.writeFile(path.join(dir, 'probe-a'), '')
      const expected = fsSyncExists(path.join(dir, 'PROBE-A'))
      await fs.rm(path.join(dir, 'probe-a'))
      expect(await localCaseInsensitive(dir)).toBe(expected)
      expect(await fs.readdir(dir)).toEqual([])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('目录不可写时按区分大小写处理', async () => {
    expect(await localCaseInsensitive(path.join(os.tmpdir(), 'filetrans-missing-dir-xyz'))).toBe(false)
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

describe('planResumeVerify', () => {
  const chunk = 256 * 1024

  it('没有已传内容时无需校验', () => {
    expect(planResumeVerify(0)).toEqual([])
  })

  it('小前缀逐块完整校验', () => {
    expect(planResumeVerify(3 * chunk)).toEqual([
      { start: 0, end: chunk - 1 },
      { start: chunk, end: 2 * chunk - 1 },
      { start: 2 * chunk, end: 3 * chunk - 1 }
    ])
  })

  it('非整块前缀的最后一块按实际长度截断', () => {
    const offset = chunk + 100
    expect(planResumeVerify(offset)).toEqual([
      { start: 0, end: chunk - 1 },
      { start: chunk, end: offset - 1 }
    ])
  })

  it('大前缀采样校验且覆盖首尾、范围有界', () => {
    const offset = 100 * chunk
    const ranges = planResumeVerify(offset)
    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges.length).toBeLessThan(100)
    expect(ranges[0].start).toBe(0)
    expect(ranges[ranges.length - 1].end).toBe(offset - 1)
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index].start).toBeGreaterThan(ranges[index - 1].end)
    }
    for (const range of ranges) {
      expect(range.start % chunk).toBe(0)
      expect(range.end).toBeGreaterThanOrEqual(range.start)
      expect(range.end).toBeLessThan(offset)
    }
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

  it.each([
    ['upload', 1024 * 1024], ['download', 1024 * 1024],
    ['upload', 512 * 1024], ['download', 512 * 1024]
  ] as const)('%s 续传校验完整前缀，拒绝损坏的 %i 字节临时文件', async (direction, size) => {
    const data = Buffer.alloc(1024 * 1024, 7)
    const corrupted = Buffer.from(data.subarray(0, size))
    corrupted[0] = 0
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness('resume')
    if (direction === 'upload') {
      await fs.writeFile(local, data)
      fake.files.set(partTarget, corrupted)
    } else {
      fake.files.set(target, data)
      await fs.writeFile(`${local}.filetrans-part`, corrupted)
    }
    const id = await manager.start({
      sessionId: 'test-session', direction,
      sources: [direction === 'upload' ? local : target],
      targetDir: direction === 'upload' ? '/remote/dest' : tempDir,
      recursive: true, options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    const result = direction === 'upload' ? fake.files.get(target) : await fs.readFile(local)
    expect(result?.equals(data)).toBe(true)
  })

  it('重启后续传同大小稀疏临时文件会重新下载完整内容', async () => {
    const data = Buffer.alloc(PARALLEL_MIN_BYTES, 7)
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(target, data)
    const handle = await fs.open(`${local}.filetrans-part`, 'w')
    await handle.write(data.subarray(-1), 0, 1, data.length - 1)
    await handle.close()
    const id = await manager.start({
      sessionId: 'test-session', direction: 'download', sources: [target],
      targetDir: tempDir, recursive: true,
      options: { resume: true, retries: 0, concurrency: 2, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect((await fs.readFile(local)).equals(data)).toBe(true)
  })

  it('重启后按旁挂状态恢复并行分段，只补未完成区间', async () => {
    const size = PARALLEL_MIN_BYTES + 4 * PARALLEL_MIN_SEGMENT
    const data = randomBytes(size)
    const remote = '/remote/src/cross.bin'
    const local = path.join(tempDir, 'cross.bin')
    const segments = planParallelSegments(size, 0, 4)
    expect(segments.length).toBe(4)
    const seg1Written = Math.floor((segments[1].end - segments[1].start) / 2)

    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(remote, data)
    const handle = await fs.open(`${local}.filetrans-part`, 'w')
    await handle.write(data.subarray(0, segments[0].end), 0, segments[0].end, 0)
    await handle.write(
      data.subarray(segments[1].start, segments[1].start + seg1Written),
      0, seg1Written, segments[1].start
    )
    await handle.write(data.subarray(size - 1), 0, 1, size - 1)
    await handle.close()
    await fs.writeFile(
      `${local}.filetrans-part.json`,
      JSON.stringify({
        base: 0,
        mtime: 1700000000,
        segments: segments.map((segment, index) => ({
          ...segment,
          written: index === 0 ? segment.end - segment.start : index === 1 ? seg1Written : 0
        }))
      })
    )

    const id = await manager.start({
      sessionId: 'test-session', direction: 'download', sources: [remote],
      targetDir: tempDir, recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fsSyncExists(`${local}.filetrans-part.json`)).toBe(false)
    const reads = fake.readLog.filter((entry) => entry.path === remote)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((entry) => entry.start !== 0)).toBe(true)
    expect(reads.some((entry) => entry.start === segments[1].start + seg1Written)).toBe(true)
    expect(reads.some((entry) => entry.start === segments[2].start)).toBe(true)
  }, 30000)

  it('旁挂状态损坏时丢弃稀疏临时文件并重新下载完整内容', async () => {
    const size = PARALLEL_MIN_BYTES + PARALLEL_MIN_SEGMENT
    const data = randomBytes(size)
    const remote = '/remote/src/broken.bin'
    const local = path.join(tempDir, 'broken.bin')
    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(remote, data)
    const handle = await fs.open(`${local}.filetrans-part`, 'w')
    await handle.write(data.subarray(size - 1), 0, 1, size - 1)
    await handle.close()
    await fs.writeFile(`${local}.filetrans-part.json`, '{broken json')

    const id = await manager.start({
      sessionId: 'test-session', direction: 'download', sources: [remote],
      targetDir: tempDir, recursive: true,
      options: { resume: true, retries: 0, concurrency: 2, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fsSyncExists(`${local}.filetrans-part.json`)).toBe(false)
    const reads = fake.readLog.filter((entry) => entry.path === remote)
    expect(reads.some((entry) => entry.start === 0)).toBe(true)
  })

  it('冲突等待期间取消立即终止传输组', async () => {
    const data = randomBytes(16 * 1024)
    const source = path.join(tempDir, 'file.bin')
    await fs.writeFile(source, data)
    let conflictSeen = false
    const { fake, events, manager } = makeHarness('resume', () => {
      conflictSeen = true
      return new Promise<void>(() => undefined)
    })
    fake.files.set(target, data)

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => conflictSeen)
    manager.cancel(id)
    await waitFor(() => latest(events, id)?.status === 'cancelled')
  })

  it('不支持的文件类型只记为跳过，其余文件照常传完且不算失败', async () => {
    const data = randomBytes(4 * 1024)
    const normal = path.join(tempDir, 'normal.bin')
    const socketPath = path.join(tempDir, 'ipc.sock')
    await fs.writeFile(normal, data)
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))

    try {
      const { fake, events, manager } = makeHarness()
      const id = await manager.start({
        sessionId: 'test-session',
        direction: 'upload',
        sources: [normal, socketPath],
        targetDir: '/remote/dest',
        recursive: true,
        options: { resume: true, retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => {
        const status = latest(events, id)?.status
        return status === 'done' || status === 'error'
      })

      const final = latest(events, id)
      expect(final?.status).toBe('done')
      expect(final?.failedCount ?? 0).toBe(0)
      expect(final?.skippedCount).toBe(1)
      expect(final?.skippedFiles?.[0].path).toBe(socketPath)
      expect(final?.warning).toContain('已跳过 1 个项目')
      expect(final?.error).toBeUndefined()
      expect(fake.files.get('/remote/dest/normal.bin')?.equals(data)).toBe(true)
      expect(fake.files.has('/remote/dest/ipc.sock')).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['upload', 'download'] as const)('%s 已有临时内容校验通过后只补传剩余部分', async (direction) => {
    const data = Buffer.alloc(1024 * 1024, 7)
    const prefixSize = 512 * 1024
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness('resume')
    if (direction === 'upload') {
      await fs.writeFile(local, data)
      fake.files.set(partTarget, data.subarray(0, prefixSize))
    } else {
      fake.files.set(target, data)
      await fs.writeFile(`${local}.filetrans-part`, data.subarray(0, prefixSize))
      await fs.writeFile(
        `${local}.filetrans-part.json`,
        JSON.stringify({ sequential: true, size: data.length, mtime: 1700000000 })
      )
    }
    const id = await manager.start({
      sessionId: 'test-session', direction,
      sources: [direction === 'upload' ? local : target],
      targetDir: direction === 'upload' ? '/remote/dest' : tempDir,
      recursive: true, options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    const result = direction === 'upload' ? fake.files.get(target) : await fs.readFile(local)
    expect(result?.equals(data)).toBe(true)
    if (direction === 'upload') expect(fake.writeLog[0].offset).toBe(prefixSize)
    else expect(fake.readLog.at(-1)?.start).toBe(prefixSize)
  })

  it.each(['upload', 'download'] as const)('%s 取消覆盖时保留旧文件', async (direction) => {
    const data = Buffer.alloc(1024 * 1024, 7)
    const old = Buffer.from('旧内容')
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness('overwrite')
    fake.writeDelayMs = 20
    fake.readDelayMs = 20
    if (direction === 'upload') {
      await fs.writeFile(local, data)
      fake.files.set(target, old)
    } else {
      fake.files.set(target, data)
      await fs.writeFile(local, old)
    }
    const id = await manager.start({
      sessionId: 'test-session', direction,
      sources: [direction === 'upload' ? local : target],
      targetDir: direction === 'upload' ? '/remote/dest' : tempDir,
      recursive: true, options: { retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => direction === 'upload'
      ? (fake.files.get(partTarget)?.length ?? 0) > 0
      : fsSyncExists(`${local}.filetrans-part`) && statSync(`${local}.filetrans-part`).size > 0)
    manager.cancel(id)
    await waitFor(() => latest(events, id)?.status === 'cancelled')
    const result = direction === 'upload' ? fake.files.get(target) : await fs.readFile(local)
    expect(result?.equals(old)).toBe(true)
  })

  it('并行尾段先完成时暂停恢复仍补齐前面未完成的分段', async () => {
    const data = Buffer.alloc(PARALLEL_MIN_BYTES, 7)
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness()
    fake.files.set(target, data)
    fake.readDelays.set(0, 20)
    const id = await manager.start({
      sessionId: 'test-session', direction: 'download', sources: [target],
      targetDir: tempDir, recursive: true,
      options: { resume: true, retries: 0, concurrency: 2, ...OFF_ATTRS }
    })
    await waitFor(() => fsSyncExists(`${local}.filetrans-part`) && statSync(`${local}.filetrans-part`).size === data.length)
    manager.pause(id)
    await waitFor(() => fake.activeReads === 0)
    const readsBefore = fake.readLog.length
    manager.resume(id)
    await waitFor(() => latest(events, id)?.status === 'done')
    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fake.readLog.length).toBeGreaterThan(readsBefore)
    expect(fake.readLog.slice(readsBefore).every((read) => read.end < PARALLEL_MIN_SEGMENT)).toBe(true)
  })

  it.each([
    ['upload', 'file'], ['upload', 'directory'], ['upload', 'symlink'],
    ['download', 'file'], ['download', 'directory'], ['download', 'symlink']
  ] as const)('%s 覆盖 %s 失败时保留旧目标', async (direction, type) => {
    const data = Buffer.alloc(1024 * 1024, 7)
    const old = Buffer.from('旧内容')
    const local = path.join(tempDir, 'file.bin')
    const { fake, events, manager } = makeHarness('overwrite')
    if (direction === 'upload') {
      await fs.writeFile(local, data)
      if (type === 'directory') {
        fake.dirs.add(target)
        fake.files.set(`${target}/old.txt`, old)
      } else if (type === 'symlink') {
        fake.links.set(target, '/remote/old.txt')
        fake.files.set('/remote/old.txt', old)
      } else fake.files.set(target, old)
      fake.failNextWriteAfter = 65536
    } else {
      fake.files.set(target, data)
      if (type === 'directory') {
        await fs.mkdir(local)
        await fs.writeFile(path.join(local, 'old.txt'), old)
      } else if (type === 'symlink') {
        await fs.writeFile(path.join(tempDir, 'old.txt'), old)
        await fs.symlink('old.txt', local)
      } else await fs.writeFile(local, old)
      fake.failNextReadAfter = 65536
    }
    const id = await manager.start({
      sessionId: 'test-session', direction,
      sources: [direction === 'upload' ? local : target],
      targetDir: direction === 'upload' ? '/remote/dest' : tempDir,
      recursive: true, options: { retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'error')
    if (direction === 'upload') {
      if (type === 'symlink') expect(fake.links.get(target)).toBe('/remote/old.txt')
      const result = fake.files.get(type === 'directory' ? `${target}/old.txt` : type === 'symlink' ? '/remote/old.txt' : target)
      expect(result?.equals(old)).toBe(true)
    } else {
      if (type === 'symlink') expect(await fs.readlink(local)).toBe('old.txt')
      expect((await fs.readFile(type === 'directory' ? path.join(local, 'old.txt') : local)).equals(old)).toBe(true)
    }
  })

  it('覆盖已存在目录时完成后替换目录', async () => {
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

  it('单个文件失败不中断同批其他文件', async () => {
    const dataA = randomBytes(64 * 1024)
    const dataB = randomBytes(64 * 1024)
    const dataC = randomBytes(64 * 1024)
    const sourceA = path.join(tempDir, 'a.bin')
    const sourceB = path.join(tempDir, 'b.bin')
    const sourceC = path.join(tempDir, 'c.bin')
    await fs.writeFile(sourceA, dataA)
    await fs.writeFile(sourceB, dataB)
    await fs.writeFile(sourceC, dataC)

    const { fake, events, manager } = makeHarness('resume')
    fake.dirs.add('/remote/dest/b.bin')

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [sourceA, sourceB, sourceC],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'error')

    const group = latest(events, id)
    expect(group?.failedCount).toBe(1)
    expect(group?.failedFiles?.map((file) => file.name)).toEqual(['b.bin'])
    expect(group?.failedFiles?.[0].error).toContain('目标为目录')
    expect(group?.doneFiles).toBe(2)
    expect(group?.totalFiles).toBe(3)
    expect(fake.files.get('/remote/dest/a.bin')?.equals(dataA)).toBe(true)
    expect(fake.files.get('/remote/dest/c.bin')?.equals(dataC)).toBe(true)
    expect(fake.files.has('/remote/dest/b.bin')).toBe(false)
  })

  it('大文件续传校验通过时只补传剩余部分且读取次数有界', async () => {
    const chunk = 256 * 1024
    const size = 12 * 1024 * 1024
    const prefixSize = 10 * 1024 * 1024
    const data = Buffer.alloc(size, 7)
    const source = path.join(tempDir, 'big.bin')
    await fs.writeFile(source, data)
    const remoteTarget = '/remote/dest/big.bin'
    const remotePart = `${remoteTarget}.filetrans-part`

    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(remotePart, Buffer.from(data.subarray(0, prefixSize)))

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')

    expect(fake.files.get(remoteTarget)?.equals(data)).toBe(true)
    expect(fake.files.has(remotePart)).toBe(false)
    const written = fake.writeLog.reduce((sum, entry) => sum + entry.length, 0)
    expect(written).toBe(size - prefixSize)
    expect(fake.readLog.length).toBeGreaterThan(0)
    expect(fake.readLog.length).toBeLessThan(Math.ceil(prefixSize / chunk))
  })

  it('大文件续传校验采到前缀末尾损坏时改为全量重传', async () => {
    const chunk = 256 * 1024
    const size = 12 * 1024 * 1024
    const prefixSize = 10 * 1024 * 1024
    const data = Buffer.alloc(size, 7)
    const source = path.join(tempDir, 'big.bin')
    await fs.writeFile(source, data)
    const remoteTarget = '/remote/dest/big.bin'
    const remotePart = `${remoteTarget}.filetrans-part`
    const corrupted = Buffer.from(data.subarray(0, prefixSize))
    corrupted[corrupted.length - 1] = 0

    const { fake, events, manager } = makeHarness('resume')
    fake.files.set(remotePart, corrupted)

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')

    expect(fake.files.get(remoteTarget)?.equals(data)).toBe(true)
    expect(fake.writeLog[0].offset).toBe(0)
    expect(fake.readLog.length).toBeLessThan(Math.ceil(prefixSize / chunk))
  })

  it('start 立即返回收集中的传输组', async () => {
    const { fake, events, manager } = makeHarness()
    fake.dirs.add('/remote/src/slow')
    fake.files.set('/remote/src/slow/a.bin', Buffer.alloc(1024, 2))
    fake.listDelayMs = 1500

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: ['/remote/src/slow'],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })
    const early = manager.list().find((group) => group.id === id)
    expect(early?.status).toBe('pending')
    expect(early?.collecting).toBe(true)
    expect(early?.totalFiles).toBe(0)

    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect((await fs.readFile(path.join(tempDir, 'slow/a.bin'))).length).toBe(1024)
    expect(latest(events, id)?.collecting).toBeFalsy()
  }, 30000)

  it('下载目录树并行展开，文件层级与内容一致', async () => {
    const { fake, events, manager } = makeHarness()
    const root = '/remote/src/tree'
    fake.dirs.add(root)
    const data = randomBytes(2048)
    for (let index = 0; index < 6; index++) {
      fake.dirs.add(`${root}/d${index}`)
      fake.files.set(`${root}/d${index}/f${index}.bin`, Buffer.from(data))
    }
    fake.dirs.add(`${root}/deep`)
    fake.dirs.add(`${root}/deep/inner`)
    fake.files.set(`${root}/deep/inner/n.bin`, Buffer.from(data))
    fake.files.set(`${root}/top.bin`, Buffer.from(data))
    fake.listDelayMs = 5

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: [root],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done', 30000)
    expect(fake.maxActiveLists).toBeGreaterThan(1)
    expect(latest(events, id)?.totalFiles).toBe(8)
    for (let index = 0; index < 6; index++) {
      expect(
        (await fs.readFile(path.join(tempDir, `tree/d${index}/f${index}.bin`))).equals(data)
      ).toBe(true)
    }
    expect((await fs.readFile(path.join(tempDir, 'tree/top.bin'))).equals(data)).toBe(true)
    expect(
      (await fs.readFile(path.join(tempDir, 'tree/deep/inner/n.bin'))).equals(data)
    ).toBe(true)
  }, 30000)

  it('取消收集中的传输组立即终止', async () => {
    const { fake, events, manager } = makeHarness()
    fake.dirs.add('/remote/src/slow')
    fake.files.set('/remote/src/slow/a.bin', Buffer.alloc(1024, 2))
    fake.listDelayMs = 3000

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: ['/remote/src/slow'],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 4, ...OFF_ATTRS }
    })
    expect(manager.list().find((group) => group.id === id)?.collecting).toBe(true)
    manager.cancel(id)
    await waitFor(() => latest(events, id)?.status === 'cancelled', 30000)
    expect(fsSyncExists(path.join(tempDir, 'slow'))).toBe(false)
  }, 30000)
  it('符号链接创建失败不影响同组其余文件与链接', async () => {
    const local = path.join(tempDir, 'pkg')
    await fs.mkdir(local, { recursive: true })
    await fs.writeFile(path.join(local, 'a.bin'), Buffer.alloc(2048, 1))
    await fs.writeFile(path.join(local, 'b.bin'), Buffer.alloc(2048, 2))
    await fs.symlink('/nonexistent/one', path.join(local, 'bad-link'))
    await fs.symlink('/nonexistent/two', path.join(local, 'good-link'))

    const { fake, events, manager } = makeHarness()
    fake.failSymlinkFor = ['/remote/dest/pkg/bad-link.filetrans-part']

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [local],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: false, retries: 0, concurrency: 1, ...OFF_ATTRS }
    })

    await waitFor(() => latest(events, id)?.status === 'error', 30000)
    const final = latest(events, id)
    expect(fake.files.get('/remote/dest/pkg/a.bin')?.length).toBe(2048)
    expect(fake.files.get('/remote/dest/pkg/b.bin')?.length).toBe(2048)
    expect(fake.links.get('/remote/dest/pkg/good-link')).toBe('/nonexistent/two')
    expect(fake.links.has('/remote/dest/pkg/bad-link')).toBe(false)
    expect(final?.status).toBe('error')
    expect(final?.failedCount).toBe(1)
    expect(final?.failedFiles?.[0].path).toBe('/remote/dest/pkg/bad-link')
  }, 30000)

  describe('冲突决议下的符号链接', () => {
    async function setupLinkOverDir(harnessResolution: ConflictResolution) {
      const dest = path.join(tempDir, 'dest')
      const linkTarget = path.join(dest, 'src', 'current')
      await fs.mkdir(linkTarget, { recursive: true })
      await fs.writeFile(path.join(linkTarget, 'local.txt'), Buffer.from('本地修改'))
      const { fake, events, manager } = makeHarness(harnessResolution)
      fake.dirs.add('/remote/src')
      fake.links.set('/remote/src/current', 'releases/v2')
      const id = await manager.start({
        sessionId: 'test-session',
        direction: 'download',
        sources: ['/remote/src'],
        targetDir: dest,
        recursive: true,
        options: { resume: true, retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => {
        const status = latest(events, id)?.status
        return status === 'done' || status === 'error'
      })
      return { linkTarget, final: latest(events, id) }
    }

    it('续传决议下链接不再递归删除同名本地目录', async () => {
      const { linkTarget, final } = await setupLinkOverDir('resume')
      expect(final?.status).toBe('error')
      expect(final?.failedFiles?.[0].error).toContain('目标为目录')
      expect((await fs.lstat(linkTarget)).isDirectory()).toBe(true)
      await expect(fs.readFile(path.join(linkTarget, 'local.txt'), 'utf8')).resolves.toBe(
        '本地修改'
      )
    })

    it('跳过决议下同名链接被过滤且目录原样保留', async () => {
      const { linkTarget, final } = await setupLinkOverDir('skip')
      expect(final?.status).toBe('done')
      expect((await fs.lstat(linkTarget)).isDirectory()).toBe(true)
      await expect(fs.readlink(linkTarget)).rejects.toThrow()
    })

    it('覆盖决议下链接按用户确认替换本地目录', async () => {
      const { linkTarget } = await setupLinkOverDir('overwrite')
      expect((await fs.lstat(linkTarget)).isSymbolicLink()).toBe(true)
      const entries = await fs.readdir(path.dirname(linkTarget))
      expect(entries.filter((name) => name.includes('filetrans-backup'))).toEqual([])
    })

    it('上传方向续传决议下链接不顶替同名远端目录', async () => {
      const local = path.join(tempDir, 'pkg')
      await fs.mkdir(path.join(local, 'sub'), { recursive: true })
      await fs.symlink('sub', path.join(local, 'current'))
      const { fake, events, manager } = makeHarness('resume')
      fake.dirs.add('/remote/dest/pkg/current')

      const id = await manager.start({
        sessionId: 'test-session',
        direction: 'upload',
        sources: [local],
        targetDir: '/remote/dest',
        recursive: true,
        options: { resume: true, retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => {
        const status = latest(events, id)?.status
        return status === 'done' || status === 'error'
      }, 30000)

      const final = latest(events, id)
      expect(final?.status).toBe('error')
      expect(final?.failedFiles?.[0].error).toContain('目标为目录')
      expect(fake.dirs.has('/remote/dest/pkg/current')).toBe(true)
      expect(fake.links.has('/remote/dest/pkg/current')).toBe(false)
    }, 30000)
  })

  it('下载时服务端返回非法或越界的文件名被跳过且不越界写入', async () => {
    const dest = path.join(tempDir, 'dl')
    await fs.mkdir(dest)
    const { fake, events, manager } = makeHarness()
    fake.dirs.add('/remote/src')
    fake.files.set('/remote/src/ok.txt', Buffer.from('ok'))
    const entry = (
      name: string,
      entryPath: string,
      size: number
    ): FileEntry => ({
      name,
      path: entryPath,
      type: 'file',
      size,
      mtime: 1700000000000,
      atime: 1700000000000,
      mode: 0o100640,
      isSymlink: false
    })
    fake.list = (async (target: string) => {
      if (target !== '/remote/src') throw new Error('No such file')
      return {
        path: target,
        parent: '/remote',
        entries: [
          entry('ok.txt', '/remote/src/ok.txt', 2),
          entry('../evil.txt', '/remote/src/evil', 4),
          entry('a/b', '/remote/src/ab', 1)
        ]
      }
    }) as typeof fake.list

    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: ['/remote/src'],
      targetDir: dest,
      recursive: true,
      options: { retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')

    const final = latest(events, id)
    expect(final?.status).toBe('done')
    expect(final?.skippedCount).toBe(2)
    expect(final?.warning).toContain('非法或越界')
    expect(await fs.readFile(path.join(dest, 'src', 'ok.txt'), 'utf8')).toBe('ok')
    expect((await fs.readdir(dest)).sort()).toEqual(['src'])
    expect((await fs.readdir(path.join(dest, 'src'))).sort()).toEqual(['ok.txt'])
    await expect(fs.access(path.join(tempDir, 'evil.txt'))).rejects.toThrow()
  })

  it('关闭保留权限时上传完成后仍设置 0644', async () => {
    const source = path.join(tempDir, 'perm.bin')
    await fs.writeFile(source, randomBytes(4096))

    const { fake, events, manager } = makeHarness()
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [source],
      targetDir: '/remote/dest',
      recursive: true,
      options: { retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.chmodCalls).toContainEqual({ path: '/remote/dest/perm.bin.filetrans-part', mode: 0o644 })
  })

  it('下载时以 .. 开头的合法文件名正常写入', async () => {
    const dest = path.join(tempDir, 'cfg')
    await fs.mkdir(dest)
    const { fake, events, manager } = makeHarness()
    fake.dirs.add('/remote/conf')
    fake.files.set('/remote/conf/..data', Buffer.from('config'))
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: ['/remote/conf'],
      targetDir: dest,
      recursive: true,
      options: { retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(latest(events, id)?.skippedCount ?? 0).toBe(0)
    expect(await fs.readFile(path.join(dest, 'conf', '..data'), 'utf8')).toBe('config')
  })

  it('长文件名下载暂停恢复后仍从断点续传', async () => {
    const name = `${'长'.repeat(65)}.bin`
    const data = randomBytes(1024 * 1024)
    const remote = `/remote/${name}`
    const local = path.join(tempDir, name)
    const { fake, events, manager } = makeHarness()
    fake.files.set(remote, data)
    fake.readDelayMs = 20
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'download',
      sources: [remote],
      targetDir: tempDir,
      recursive: true,
      options: { resume: true, retries: 0, concurrency: 1, ...OFF_ATTRS }
    })
    const part = `${local}.filetrans-part`
    await waitFor(() => fsSyncExists(part) && statSync(part).size > 0)
    manager.pause(id)
    await waitFor(() => latest(events, id)?.status === 'paused')
    await waitFor(() => fake.activeReads === 0)
    manager.resume(id)
    await waitFor(() => latest(events, id)?.status === 'done')
    expect((await fs.readFile(local)).equals(data)).toBe(true)
    expect(fake.readLog[fake.readLog.length - 1].start).toBeGreaterThan(0)
  })

  it('选择跳过时只剩临时文件的目标按续传补齐', async () => {
    const srcDir = path.join(tempDir, 'partial')
    await fs.mkdir(srcDir)
    const data = randomBytes(512 * 1024)
    await fs.writeFile(path.join(srcDir, 'big.bin'), data)
    await fs.writeFile(path.join(srcDir, 'old.txt'), 'new')
    const { fake, events, manager } = makeHarness('skip')
    await fake.mkdirp('/remote/dest/partial')
    fake.files.set(
      '/remote/dest/partial/big.bin.filetrans-part',
      Buffer.from(data.subarray(0, 200 * 1024))
    )
    fake.files.set('/remote/dest/partial/old.txt', Buffer.from('old'))
    const id = await manager.start({
      sessionId: 'test-session',
      direction: 'upload',
      sources: [srcDir],
      targetDir: '/remote/dest',
      recursive: true,
      options: { resume: true, retries: 0, ...OFF_ATTRS }
    })
    await waitFor(() => latest(events, id)?.status === 'done')
    expect(fake.files.get('/remote/dest/partial/big.bin')?.equals(data)).toBe(true)
    expect(fake.files.get('/remote/dest/partial/old.txt')?.toString()).toBe('old')
    expect(
      fake.writeLog.some(
        (entry) =>
          entry.path === '/remote/dest/partial/big.bin.filetrans-part' && entry.offset === 200 * 1024
      )
    ).toBe(true)
  })

  describe('断线后恢复', () => {
    function makeReconnectHarness() {
      const first = new FakeSession()
      const second = new FakeSession()
      second.id = 'fake-session-2'
      second.files = first.files
      second.dirs = first.dirs
      second.links = first.links
      const events: TransferGroup[] = []
      const prompts: ConflictPrompt[] = []
      let current = first
      let manager: TransferManager
      const webContents = {
        send: (channel: string, payload: unknown) => {
          if (channel === IPC.evtTransferUpdate) {
            events.push(payload as TransferGroup)
          } else if (channel === IPC.evtConflictPrompt) {
            const prompt = payload as ConflictPrompt
            prompts.push(prompt)
            setTimeout(() => manager.resolveConflict(prompt.transferId, 'skip'), 0)
          }
        }
      } as unknown as WebContents
      const sessions = {
        get: () => current,
        findByParams: () => (second.connected ? second : undefined)
      } as unknown as SessionManager
      manager = new TransferManager(() => webContents, sessions)
      const drop = (): void => {
        first.connected = false
        current = second
        manager.handleSessionClosed(first.id)
      }
      return { first, events, prompts, manager, drop }
    }

    it('上传冲突检测期间断线，恢复后重新检测冲突而不静默覆盖已有文件', async () => {
      const srcDir = path.join(tempDir, 'up')
      await fs.mkdir(srcDir)
      await fs.writeFile(path.join(srcDir, 'a.txt'), 'new-a')
      await fs.writeFile(path.join(srcDir, 'b.txt'), 'new-b')
      const { first, events, prompts, manager, drop } = makeReconnectHarness()
      await first.mkdirp('/remote/dest/up')
      first.files.set('/remote/dest/up/a.txt', Buffer.from('old-a'))
      const lstat = first.lstat.bind(first)
      first.lstat = async (target: string) => {
        if (target === '/remote/dest/up/a.txt' && first.connected) drop()
        if (!first.connected) throw new Error('SFTP 会话未连接')
        return lstat(target)
      }

      const id = await manager.start({
        sessionId: 'fake-session',
        direction: 'upload',
        sources: [srcDir],
        targetDir: '/remote/dest',
        recursive: true,
        options: { resume: false, retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => latest(events, id)?.status === 'paused')
      manager.resume(id)
      await waitFor(() => latest(events, id)?.status === 'done')

      expect(
        prompts.some((prompt) =>
          prompt.items.some((item) => item.targetPath === '/remote/dest/up/a.txt')
        )
      ).toBe(true)
      expect(first.files.get('/remote/dest/up/a.txt')?.toString()).toBe('old-a')
      expect(first.files.get('/remote/dest/up/b.txt')?.toString()).toBe('new-b')
    })

    it('上传建目录时断线，恢复后补建目录并传完全部文件', async () => {
      const srcDir = path.join(tempDir, 'tree')
      await fs.mkdir(path.join(srcDir, 'sub'), { recursive: true })
      await fs.writeFile(path.join(srcDir, 'sub', 'a.txt'), 'a')
      await fs.writeFile(path.join(srcDir, 'top.txt'), 'top')
      const { first, events, manager, drop } = makeReconnectHarness()
      const mkdirp = first.mkdirp.bind(first)
      first.mkdirp = async (target: string) => {
        if (target === '/remote/dest/tree/sub' && first.connected) drop()
        if (!first.connected) throw new Error('SFTP 会话未连接')
        return mkdirp(target)
      }

      const id = await manager.start({
        sessionId: 'fake-session',
        direction: 'upload',
        sources: [srcDir],
        targetDir: '/remote/dest',
        recursive: true,
        options: { retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => latest(events, id)?.status === 'paused')
      manager.resume(id)
      await waitFor(() => latest(events, id)?.status === 'done')

      expect(latest(events, id)?.failedCount ?? 0).toBe(0)
      expect(first.files.get('/remote/dest/tree/sub/a.txt')?.toString()).toBe('a')
      expect(first.files.get('/remote/dest/tree/top.txt')?.toString()).toBe('top')
    })

    it('上传创建符号链接时断线，恢复后链接照常创建', async () => {
      const srcDir = path.join(tempDir, 'withlink')
      await fs.mkdir(srcDir)
      await fs.writeFile(path.join(srcDir, 'top.txt'), 'top')
      await fs.symlink('top.txt', path.join(srcDir, 'link'))
      const { first, events, manager, drop } = makeReconnectHarness()
      first.symlink = async () => {
        if (first.connected) drop()
        throw new Error('SFTP 会话未连接')
      }

      const id = await manager.start({
        sessionId: 'fake-session',
        direction: 'upload',
        sources: [srcDir],
        targetDir: '/remote/dest',
        recursive: true,
        options: { retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => latest(events, id)?.status === 'paused')
      manager.resume(id)
      await waitFor(() => latest(events, id)?.status === 'done')

      expect(latest(events, id)?.failedCount ?? 0).toBe(0)
      expect(first.links.has('/remote/dest/withlink/link')).toBe(true)
      expect(first.files.get('/remote/dest/withlink/top.txt')?.toString()).toBe('top')
    })

    it('下载展开子目录时断线，恢复后重新展开而不静默跳过子目录', async () => {
      const dest = path.join(tempDir, 'dl-reconnect')
      await fs.mkdir(dest)
      const { first, events, manager, drop } = makeReconnectHarness()
      first.dirs.add('/remote/src')
      first.dirs.add('/remote/src/sub1')
      first.dirs.add('/remote/src/sub2')
      first.files.set('/remote/src/top.txt', Buffer.from('top'))
      first.files.set('/remote/src/sub1/a.txt', Buffer.from('a'))
      first.files.set('/remote/src/sub2/b.txt', Buffer.from('b'))
      const list = first.list.bind(first)
      first.list = async (target: string) => {
        if (target === '/remote/src/sub2' && first.connected) drop()
        if (!first.connected) throw new Error('SFTP 会话未连接')
        return list(target)
      }

      const id = await manager.start({
        sessionId: 'fake-session',
        direction: 'download',
        sources: ['/remote/src'],
        targetDir: dest,
        recursive: true,
        options: { retries: 0, ...OFF_ATTRS }
      })
      await waitFor(() => latest(events, id)?.status === 'paused')
      manager.resume(id)
      await waitFor(() => latest(events, id)?.status === 'done')

      expect(latest(events, id)?.skippedCount ?? 0).toBe(0)
      expect(await fs.readFile(path.join(dest, 'src', 'top.txt'), 'utf8')).toBe('top')
      expect(await fs.readFile(path.join(dest, 'src', 'sub1', 'a.txt'), 'utf8')).toBe('a')
      expect(await fs.readFile(path.join(dest, 'src', 'sub2', 'b.txt'), 'utf8')).toBe('b')
    })
  })
})
