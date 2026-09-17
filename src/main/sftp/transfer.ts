import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { typeFromMode } from '@shared/format'
import { posixBasename, posixDirname, posixJoin, posixRelative } from '@shared/path'
import type {
  ConflictItem,
  ConflictPrompt,
  ConflictResolution,
  TransferDirection,
  TransferFileProgress,
  TransferGroup,
  TransferOptions,
  TransferStartRequest
} from '@shared/types'
import type { SessionManager } from './manager'
import type { SftpSession } from './session'
import { replaceWithRollback } from '../replace'

const MAX_CONCURRENT_FILES = 3
const FLUSH_INTERVAL_MS = 300
const CONFLICT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_DEPTH = 128
const RETRY_DELAY_MS = 2000
const PERMISSION_MASK = 0o7777
export const MAX_FILE_CONCURRENCY = 16
export const PARALLEL_MIN_BYTES = 8 * 1024 * 1024
export const PARALLEL_MIN_SEGMENT = 4 * 1024 * 1024
const PARALLEL_READ_HWM = 256 * 1024
const PARALLEL_WRITE_HWM = 256 * 1024
const PART_SUFFIX = '.filetrans-part'
const RESUME_VERIFY_BYTES = 256 * 1024
const MAX_FINISHED_GROUPS = 50

const DEFAULT_OPTIONS: TransferOptions = {
  resume: true,
  retries: 2,
  concurrency: 8,
  preserveTimestamps: true,
  preservePermissions: true
}

function clampConcurrency(value: unknown): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_OPTIONS.concurrency
  return Math.min(parsed, MAX_FILE_CONCURRENCY)
}

interface Job {
  id: number
  source: string
  target: string
  size: number
  transferred: number
  speed: number
  speedAt: number
  speedBytes: number
  mode?: number
  atime?: number
  mtime?: number
  attempted?: boolean
  /** 源文件在传输前发生了变化（大小或修改时间） */
  sourceChanged?: boolean
  /** 并行分块下载的分段进度（用于断点续传） */
  parallel?: ParallelState
}

type JobInit = Omit<Job, 'id' | 'speed' | 'speedAt' | 'speedBytes'>

function makeJob(init: JobInit): Job {
  return { ...init, id: 0, speed: 0, speedAt: 0, speedBytes: 0 }
}

interface DirJob {
  path: string
  mode?: number
  atime?: number
  mtime?: number
}

interface LinkJob {
  linkPath: string
  target: string
}

interface Collected {
  jobs: Job[]
  dirs: DirJob[]
  links: LinkJob[]
}

interface ScopeRoot {
  sourceRoot: string
  destRoot: string
}

interface WalkContext {
  roots: ScopeRoot[]
  visited: Set<string>
}

interface GroupState {
  group: TransferGroup
  options: TransferOptions
  resolution?: ConflictResolution
  jobs: Job[]
  dirs: DirJob[]
  links: LinkJob[]
  active: Set<Job>
  cursor: number
  cancelled: boolean
  paused: boolean
  resumeConflicts: boolean
  error?: Error
  aborts: Set<() => void>
  pauseWaiters: Set<() => void>
  flushTimer: NodeJS.Timeout
  lastFlush: number
  lastBytes: number
}

export interface ResumePlan {
  complete: boolean
  offset: number
}

export function resolveResumeOffset(sourceSize: number, destSize: number | null): ResumePlan {
  if (destSize === null || destSize > sourceSize) return { complete: false, offset: 0 }
  if (destSize === sourceSize) return { complete: true, offset: sourceSize }
  return { complete: false, offset: destSize }
}

export interface ParallelSegment {
  start: number
  end: number
  written: number
}

export interface ParallelState {
  base: number
  segments: ParallelSegment[]
}

export function planParallelSegments(
  sourceSize: number,
  offset: number,
  concurrency: number
): ParallelSegment[] {
  const remaining = sourceSize - offset
  if (remaining <= 0) return []
  const maxBySize = Math.max(1, Math.floor(remaining / PARALLEL_MIN_SEGMENT))
  const count = Math.max(1, Math.min(concurrency, maxBySize))
  const segmentSize = Math.ceil(remaining / count)
  const segments: ParallelSegment[] = []
  for (let start = offset; start < sourceSize; start += segmentSize) {
    segments.push({ start, end: Math.min(sourceSize, start + segmentSize), written: 0 })
  }
  return segments
}

export function isParallelComplete(state: ParallelState, sourceSize: number): boolean {
  const written = state.base + state.segments.reduce((sum, seg) => sum + seg.written, 0)
  return written >= sourceSize
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function markAborted(error: unknown): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  ;(wrapped as Error & { aborted?: boolean }).aborted = true
  return wrapped
}

function isAbortedError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { aborted?: boolean }).aborted === true
}

async function localLexists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

async function localSize(target: string): Promise<number | null> {
  try {
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink()) return null
    return stats.size
  } catch {
    return null
  }
}

function findScope(roots: ScopeRoot[], resolved: string): ScopeRoot | undefined {
  let best: ScopeRoot | undefined
  for (const root of roots) {
    const prefix = root.sourceRoot.endsWith('/') ? root.sourceRoot : `${root.sourceRoot}/`
    if (resolved === root.sourceRoot || resolved.startsWith(prefix)) {
      if (!best || root.sourceRoot.length > best.sourceRoot.length) best = root
    }
  }
  return best
}

interface FileAttributes {
  mode?: number
  atime?: number
  mtime?: number
}

function localAttributes(stats: { mode: number; atimeMs: number; mtimeMs: number }): FileAttributes {
  return { mode: stats.mode, atime: stats.atimeMs / 1000, mtime: stats.mtimeMs / 1000 }
}

function remoteAttributes(stats: { mode: number; atime: number; mtime: number }): FileAttributes {
  return { mode: stats.mode, atime: stats.atime, mtime: stats.mtime }
}

function entryAttributes(entry: {
  mode: number
  atime: number
  mtime: number
}): FileAttributes {
  return { mode: entry.mode, atime: entry.atime / 1000, mtime: entry.mtime / 1000 }
}

function partOf(target: string): string {
  return `${target}${PART_SUFFIX}`
}

async function readLocalRange(file: string, start: number, end: number): Promise<Buffer | null> {
  try {
    const length = end - start + 1
    if (length <= 0) return Buffer.alloc(0)
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, start)
      return buffer.subarray(0, result.bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function readRemoteRange(
  state: GroupState,
  session: SftpSession,
  target: string,
  start: number,
  end: number
): Promise<Buffer | null> {
  const reader = session.createReadStream(target, {
    start,
    end,
    highWaterMark: PARALLEL_READ_HWM
  })
  const chunks: Buffer[] = []
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(chunk)
      callback()
    }
  })
  let aborted = false
  const abort = (): void => {
    aborted = true
    reader.destroy(new Error('传输已中断'))
    sink.destroy(new Error('传输已中断'))
  }
  state.aborts.add(abort)
  try {
    await pipeline(reader as never, sink as never)
    return Buffer.concat(chunks)
  } catch (err) {
    throw aborted ? markAborted(err) : new Error(`读取远端数据失败: ${(err as Error).message}`)
  } finally {
    state.aborts.delete(abort)
  }
}

export class TransferManager {
  private groups = new Map<string, GroupState>()
  private conflictWaiters = new Map<string, (resolution: ConflictResolution) => void>()
  private conflictItems = new Map<string, ConflictItem[]>()

  constructor(
    private getWebContents: () => WebContents | null,
    private sessions: SessionManager
  ) {}

  async start(req: TransferStartRequest): Promise<string> {
    const session = this.sessions.get(req.sessionId)
    if (req.sources.length === 0) throw new Error('没有选择文件')

    const options: TransferOptions = { ...DEFAULT_OPTIONS, ...req.options }
    options.concurrency = clampConcurrency(options.concurrency)
    const collected =
      req.direction === 'upload'
        ? await this.collectUploadJobs(req.sources, req.targetDir, req.recursive)
        : await this.collectDownloadJobs(session, req.sources, req.targetDir, req.recursive)

    if (collected.jobs.length === 0 && collected.dirs.length === 0 && collected.links.length === 0) {
      throw new Error('没有可传输的文件')
    }

    const id = randomUUID()
    let jobs = collected.jobs
    let links = collected.links
    let resumeConflicts = false
    let resolution: ConflictResolution | undefined

    const targets = [...jobs.map((job) => job.target), ...links.map((link) => link.linkPath)]
    const conflicts: ConflictItem[] = []
    for (const target of targets) {
      const part = partOf(target)
      const isUpload = req.direction === 'upload'
      const exists = isUpload
        ? (await session.lexists(target)) || (await session.lexists(part))
        : (await localLexists(target)) || (await localLexists(part))
      if (!exists) continue
      const finalStats = isUpload
        ? await session.lstat(target).catch(() => undefined)
        : await fs.lstat(target).catch(() => undefined)
      const partStats =
        finalStats === undefined
          ? isUpload
            ? await session.lstat(part).catch(() => undefined)
            : await fs.lstat(part).catch(() => undefined)
          : undefined
      const info = finalStats ?? partStats
      const type = info ? typeFromMode(info.mode) : 'file'
      conflicts.push({
        targetPath: target,
        size: info?.size ?? 0,
        type: type === 'directory' ? 'directory' : type === 'symlink' ? 'symlink' : 'file'
      })
    }

    if (conflicts.length > 0) {
      resolution = await this.askConflict(id, conflicts)
      if (resolution === 'cancel') throw new Error('已取消传输')
      if (resolution === 'skip') {
        const skipSet = new Set(conflicts.map((conflict) => conflict.targetPath))
        jobs = jobs.filter((job) => !skipSet.has(job.target))
        links = links.filter((link) => !skipSet.has(link.linkPath))
        await this.cleanupParts(session, req.direction, conflicts.map((conflict) => conflict.targetPath))
        if (jobs.length === 0 && links.length === 0 && collected.dirs.length === 0) {
          throw new Error('目标文件均已存在，已跳过全部传输')
        }
      }
      resumeConflicts = resolution === 'resume'
      if (resolution === 'overwrite') {
        await this.cleanupParts(session, req.direction, targets)
      }
    }

    jobs.forEach((job, index) => {
      job.id = index
    })
    const totalBytes = jobs.reduce((sum, job) => sum + job.size, 0)
    const totalFiles = jobs.length + links.length
    const label =
      req.sources.length === 1 ? posixBasename(req.sources[0]) : `${req.sources.length} 个项目`
    const group: TransferGroup = {
      id,
      sessionId: req.sessionId,
      direction: req.direction,
      sourceLabel: label,
      targetDir: req.targetDir,
      status: 'pending',
      totalFiles,
      doneFiles: 0,
      totalBytes,
      transferredBytes: 0,
      speed: 0,
      retryCount: 0,
      startedAt: Date.now()
    }
    const now = Date.now()
    const state: GroupState = {
      group,
      options,
      resolution,
      jobs,
      dirs: collected.dirs,
      links,
      active: new Set(),
      cursor: 0,
      cancelled: false,
      paused: false,
      resumeConflicts,
      aborts: new Set(),
      pauseWaiters: new Set(),
      flushTimer: setInterval(() => this.flush(state), FLUSH_INTERVAL_MS),
      lastFlush: now,
      lastBytes: 0
    }
    this.groups.set(id, state)
    this.emit(state)
    void this.run(state, session).catch(() => undefined)
    return id
  }

  cancel(id: string): void {
    const state = this.groups.get(id)
    if (!state) return
    state.cancelled = true
    for (const abort of state.aborts) abort()
    this.releasePauseWaiters(state)
  }

  pause(id: string): void {
    const state = this.groups.get(id)
    if (!state || state.cancelled || state.paused) return
    state.paused = true
    if (state.group.status === 'active' || state.group.status === 'pending') {
      state.group.status = 'paused'
    }
    for (const abort of state.aborts) abort()
    for (const job of state.active) job.speed = 0
    this.emit(state)
  }

  resume(id: string): void {
    const state = this.groups.get(id)
    if (!state || state.cancelled || !state.paused) return
    state.paused = false
    if (state.group.status === 'paused') state.group.status = 'active'
    this.releasePauseWaiters(state)
    this.emit(state)
  }

  resolveConflict(id: string, resolution: ConflictResolution): void {
    const waiter = this.conflictWaiters.get(id)
    if (!waiter) return
    this.conflictWaiters.delete(id)
    waiter(resolution)
  }

  private releasePauseWaiters(state: GroupState): void {
    for (const resolve of state.pauseWaiters) resolve()
    state.pauseWaiters.clear()
  }

  private waitWhilePaused(state: GroupState): Promise<void> {
    if (!state.paused || state.cancelled) return Promise.resolve()
    return new Promise((resolve) => {
      state.pauseWaiters.add(resolve)
    })
  }

  private askConflict(transferId: string, items: ConflictItem[]): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.conflictWaiters.delete(transferId)
        this.conflictItems.delete(transferId)
        this.getWebContents()?.send(IPC.evtConflictExpired, transferId)
        resolve('cancel')
      }, CONFLICT_TIMEOUT_MS)
      this.conflictItems.set(transferId, items)
      this.conflictWaiters.set(transferId, (resolution) => {
        clearTimeout(timer)
        this.conflictItems.delete(transferId)
        resolve(resolution)
      })
      this.getWebContents()?.send(IPC.evtConflictPrompt, { transferId, items })
    })
  }

  list(): TransferGroup[] {
    this.pruneFinished()
    return [...this.groups.values()].map((state) => ({ ...state.group, activeFiles: this.activeFiles(state) }))
  }

  pendingConflicts(): ConflictPrompt[] {
    return [...this.conflictWaiters.keys()]
      .map((transferId) => {
        const items = this.conflictItems.get(transferId)
        return items ? { transferId, items } : null
      })
      .filter((prompt): prompt is ConflictPrompt => prompt !== null)
  }

  cancelAll(): void {
    for (const id of this.groups.keys()) this.cancel(id)
  }

  private pruneFinished(): void {
    const finished = [...this.groups.values()]
      .filter(
        (state) =>
          state.group.status === 'done' ||
          state.group.status === 'error' ||
          state.group.status === 'cancelled'
      )
      .sort((a, b) => (a.group.finishedAt ?? 0) - (b.group.finishedAt ?? 0))
    while (finished.length > MAX_FINISHED_GROUPS) {
      const oldest = finished.shift()
      if (oldest) this.groups.delete(oldest.group.id)
    }
  }

  private async cleanupParts(
    session: SftpSession,
    direction: TransferDirection,
    targets: string[]
  ): Promise<void> {
    for (const target of targets) {
      const part = partOf(target)
      try {
        if (direction === 'upload') {
          if (await session.lexists(part)) await session.removeEntries([part])
        } else {
          await fs.rm(part, { force: true })
        }
      } catch {
        /* 清理残留临时文件失败不阻断 */
      }
    }
  }

  private async collectUploadJobs(
    sources: string[],
    targetDir: string,
    recursive: boolean
  ): Promise<Collected> {
    const collected: Collected = { jobs: [], dirs: [], links: [] }
    const ctx: WalkContext = { roots: [], visited: new Set() }

    for (const source of sources) {
      let stats
      try {
        stats = await fs.stat(source)
      } catch {
        throw new Error(`无法访问: ${source}`)
      }
      const target = posixJoin(targetDir, path.basename(source))
      if (stats.isDirectory()) {
        if (!recursive) continue
        const resolved = await fs.realpath(source).catch(() => path.resolve(source))
        ctx.roots.push({ sourceRoot: resolved, destRoot: target })
        ctx.visited.add(resolved)
        collected.dirs.push({ path: target, ...localAttributes(stats) })
        await this.walkLocal(source, target, ctx, collected, 0)
      } else if (stats.isFile()) {
        collected.jobs.push(
          makeJob({
            source,
            target,
            size: stats.size,
            transferred: 0,
            ...localAttributes(stats)
          })
        )
      } else {
        throw new Error(`不支持的文件类型: ${source}`)
      }
    }
    return collected
  }

  private async walkLocal(
    dir: string,
    remoteDir: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number
  ): Promise<void> {
    if (depth > MAX_DEPTH) return
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name)
      const remote = posixJoin(remoteDir, dirent.name)
      if (dirent.isSymbolicLink()) {
        await this.handleLocalSymlink(full, remote, ctx, collected, depth)
      } else if (dirent.isDirectory()) {
        const stats = await fs.lstat(full)
        collected.dirs.push({ path: remote, ...localAttributes(stats) })
        await this.walkLocal(full, remote, ctx, collected, depth + 1)
      } else if (dirent.isFile()) {
        const stats = await fs.lstat(full)
        collected.jobs.push(
          makeJob({
            source: full,
            target: remote,
            size: stats.size,
            transferred: 0,
            ...localAttributes(stats)
          })
        )
      }
    }
  }

  private async handleLocalSymlink(
    linkPath: string,
    remoteLinkPath: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number
  ): Promise<void> {
    let linkTarget: string | undefined
    try {
      linkTarget = await fs.readlink(linkPath)
    } catch {
      return
    }
    const resolved = await fs.realpath(linkPath).catch(() => undefined)

    if (resolved) {
      const root = findScope(ctx.roots, resolved)
      if (root) {
        const relative = path.relative(root.sourceRoot, resolved).split(path.sep).join('/')
        const remoteTarget = posixJoin(root.destRoot, relative)
        collected.links.push({
          linkPath: remoteLinkPath,
          target: path.isAbsolute(linkTarget)
            ? remoteTarget
            : posixRelative(posixDirname(remoteLinkPath), remoteTarget)
        })
        return
      }

      const stats = await fs.stat(linkPath).catch(() => undefined)
      if (stats?.isFile()) {
        collected.jobs.push(
          makeJob({
            source: linkPath,
            target: remoteLinkPath,
            size: stats.size,
            transferred: 0,
            ...localAttributes(stats)
          })
        )
        return
      }
      if (stats?.isDirectory()) {
        if (ctx.visited.has(resolved)) {
          collected.links.push({ linkPath: remoteLinkPath, target: linkTarget })
          return
        }
        ctx.visited.add(resolved)
        collected.dirs.push({ path: remoteLinkPath, ...localAttributes(stats) })
        await this.walkLocal(linkPath, remoteLinkPath, ctx, collected, depth + 1)
        return
      }
    }
    collected.links.push({ linkPath: remoteLinkPath, target: linkTarget })
  }

  private async collectDownloadJobs(
    session: SftpSession,
    sources: string[],
    targetDir: string,
    recursive: boolean
  ): Promise<Collected> {
    const collected: Collected = { jobs: [], dirs: [], links: [] }
    const ctx: WalkContext = { roots: [], visited: new Set() }

    for (const source of sources) {
      const stats = await session.stat(source)
      const target = path.join(targetDir, posixBasename(source))
      const type = typeFromMode(stats.mode)
      if (type === 'directory') {
        if (!recursive) continue
        const resolved = await session.realpath(source).catch(() => source)
        ctx.roots.push({ sourceRoot: resolved, destRoot: target })
        ctx.visited.add(resolved)
        collected.dirs.push({ path: target, ...remoteAttributes(stats) })
        await this.walkRemote(session, source, target, ctx, collected, 0)
      } else if (type === 'file') {
        collected.jobs.push(
          makeJob({
            source,
            target,
            size: stats.size,
            transferred: 0,
            ...remoteAttributes(stats)
          })
        )
      }
    }
    return collected
  }

  private async walkRemote(
    session: SftpSession,
    remoteDir: string,
    localDir: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number
  ): Promise<void> {
    if (depth > MAX_DEPTH) return
    const listing = await session.list(remoteDir)
    for (const entry of listing.entries) {
      const local = path.join(localDir, entry.name)
      if (entry.isSymlink) {
        await this.handleRemoteSymlink(session, entry.path, local, ctx, collected, depth)
      } else if (entry.type === 'directory') {
        collected.dirs.push({ path: local, ...entryAttributes(entry) })
        await this.walkRemote(session, entry.path, local, ctx, collected, depth + 1)
      } else if (entry.type === 'file') {
        collected.jobs.push(
          makeJob({
            source: entry.path,
            target: local,
            size: entry.size,
            transferred: 0,
            ...entryAttributes(entry)
          })
        )
      }
    }
  }

  private async handleRemoteSymlink(
    session: SftpSession,
    remoteLinkPath: string,
    localLinkPath: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number
  ): Promise<void> {
    const linkTarget = await session.readlink(remoteLinkPath).catch(() => undefined)
    const resolved = await session.realpath(remoteLinkPath).catch(() => undefined)

    if (resolved) {
      const root = findScope(ctx.roots, resolved)
      if (root) {
        const relative = posixRelative(root.sourceRoot, resolved)
        const localTarget = path.join(root.destRoot, relative)
        collected.links.push({
          linkPath: localLinkPath,
          target:
            linkTarget && path.isAbsolute(linkTarget)
              ? localTarget
              : path.relative(path.dirname(localLinkPath), localTarget)
        })
        return
      }

      const stats = await session.stat(remoteLinkPath).catch(() => undefined)
      const type = stats ? typeFromMode(stats.mode) : undefined
      if (stats && type === 'file') {
        collected.jobs.push(
          makeJob({
            source: remoteLinkPath,
            target: localLinkPath,
            size: stats.size,
            transferred: 0,
            ...remoteAttributes(stats)
          })
        )
        return
      }
      if (stats && type === 'directory') {
        if (ctx.visited.has(resolved)) {
          if (linkTarget) collected.links.push({ linkPath: localLinkPath, target: linkTarget })
          return
        }
        ctx.visited.add(resolved)
        collected.dirs.push({ path: localLinkPath, ...remoteAttributes(stats) })
        await this.walkRemote(session, remoteLinkPath, localLinkPath, ctx, collected, depth + 1)
        return
      }
    }
    if (linkTarget) collected.links.push({ linkPath: localLinkPath, target: linkTarget })
  }

  private async run(state: GroupState, session: SftpSession): Promise<void> {
    const group = state.group
    group.status = state.paused ? 'paused' : 'active'
    this.emit(state)
    try {
      for (const dir of state.dirs) {
        if (state.cancelled) break
        await this.waitWhilePaused(state)
        if (state.cancelled) break
        if (group.direction === 'upload') await session.mkdirp(dir.path)
        else await fs.mkdir(dir.path, { recursive: true })
      }
      for (const link of state.links) {
        if (state.cancelled) break
        await this.waitWhilePaused(state)
        if (state.cancelled) break
        await this.createSymlink(session, state, link)
        group.doneFiles++
        this.emit(state)
      }
      const workerCount = Math.min(MAX_CONCURRENT_FILES, Math.max(1, state.jobs.length))
      await Promise.all(Array.from({ length: workerCount }, () => this.worker(state, session)))
      if (!state.cancelled) await this.applyDirAttributes(state, session)
    } catch (err) {
      if (!state.cancelled) state.error = err instanceof Error ? err : new Error(String(err))
    }
    clearInterval(state.flushTimer)
    if (state.cancelled && !state.error) {
      group.status = 'cancelled'
    } else if (state.error) {
      group.status = 'error'
      group.error = state.error.message
    } else {
      group.status = 'done'
      group.doneFiles = group.totalFiles
      group.transferredBytes = group.totalBytes
    }
    group.speed = 0
    group.finishedAt = Date.now()
    this.emit(state)
  }

  private async createSymlink(
    session: SftpSession,
    state: GroupState,
    link: LinkJob
  ): Promise<void> {
    const upload = state.group.direction === 'upload'
    const partTarget = partOf(link.linkPath)
    if (upload) {
      if (await session.lexists(partTarget)) await session.removeEntries([partTarget])
      await session.symlink(link.target, partTarget)
    } else {
      await fs.rm(partTarget, { force: true })
      await fs.symlink(link.target, partTarget)
    }
    if (state.cancelled) return
    await this.finalizeTarget(session, upload, partTarget, link.linkPath)
  }

  private async worker(state: GroupState, session: SftpSession): Promise<void> {
    for (;;) {
      if (state.cancelled) return
      await this.waitWhilePaused(state)
      if (state.cancelled) return
      const job = state.jobs[state.cursor++]
      if (!job) return
      state.active.add(job)
      this.emit(state)
      try {
        await this.runJobWithRetry(state, session, job)
        state.group.doneFiles++
        state.group.retryCount = 0
      } catch (err) {
        if (state.cancelled) return
        state.error = err instanceof Error ? err : new Error(String(err))
        state.cancelled = true
        for (const abort of state.aborts) abort()
        this.releasePauseWaiters(state)
        return
      } finally {
        state.active.delete(job)
      }
    }
  }

  private async runJobWithRetry(state: GroupState, session: SftpSession, job: Job): Promise<void> {
    let failures = 0
    for (;;) {
      if (state.cancelled) throw new Error('传输已取消')
      await this.waitWhilePaused(state)
      if (state.cancelled) throw new Error('传输已取消')
      try {
        await this.runJob(state, session, job)
        return
      } catch (err) {
        if (state.cancelled) throw err
        if (isAbortedError(err)) {
          job.attempted = true
          continue
        }
        failures++
        if (failures > state.options.retries) throw err
        job.attempted = true
        state.group.retryCount = failures
        this.emit(state)
        await delay(RETRY_DELAY_MS)
      }
    }
  }

  private async syncSourceStats(state: GroupState, session: SftpSession, job: Job): Promise<void> {
    const upload = state.group.direction === 'upload'
    let size: number
    let mtime: number
    let attrs: FileAttributes
    try {
      if (upload) {
        const stats = await fs.stat(job.source)
        size = stats.size
        attrs = localAttributes(stats)
        mtime = Math.floor(stats.mtimeMs / 1000)
      } else {
        const stats = await session.stat(job.source)
        size = stats.size
        attrs = remoteAttributes(stats)
        mtime = Math.floor(stats.mtime)
      }
    } catch {
      throw new Error(`无法访问源文件: ${job.source}`)
    }
    if (size !== job.size) {
      job.sourceChanged = true
      state.group.totalBytes = Math.max(0, state.group.totalBytes + (size - job.size))
      job.size = size
    }
    if (job.mtime !== undefined && mtime !== Math.floor(job.mtime)) job.sourceChanged = true
    job.mode = attrs.mode
    job.atime = attrs.atime
    job.mtime = mtime
  }

  private async verifyResumePrefix(
    state: GroupState,
    session: SftpSession,
    job: Job,
    upload: boolean,
    destPath: string,
    offset: number
  ): Promise<boolean> {
    for (let start = 0; start < offset; start += RESUME_VERIFY_BYTES) {
      if (state.cancelled || state.paused) throw markAborted(new Error('传输已中断'))
      const end = Math.min(offset, start + RESUME_VERIFY_BYTES) - 1
      try {
        const source = upload
          ? await readLocalRange(job.source, start, end)
          : await readRemoteRange(state, session, job.source, start, end)
        const dest = upload
          ? await readRemoteRange(state, session, destPath, start, end)
          : await readLocalRange(destPath, start, end)
        if (!source || !dest || source.length !== end - start + 1 || !source.equals(dest)) {
          return false
        }
      } catch (err) {
        if (isAbortedError(err)) throw err
        return false
      }
    }
    return true
  }

  private async moveToPart(
    session: SftpSession,
    upload: boolean,
    target: string
  ): Promise<boolean> {
    try {
      const stats = upload ? await session.lstat(target) : await fs.lstat(target)
      const isSymlink = upload
        ? typeFromMode(stats.mode) === 'symlink'
        : stats.isSymbolicLink()
      if (isSymlink) {
        return false
      }
      if (upload) await session.finalizeTransfer(target, partOf(target))
      else await fs.rename(target, partOf(target))
      return true
    } catch {
      return false
    }
  }

  private async discardPartial(
    session: SftpSession,
    upload: boolean,
    target: string
  ): Promise<void> {
    const part = partOf(target)
    try {
      if (upload) {
        if (await session.lexists(part)) await session.removeEntries([part])
      } else {
        await fs.rm(part, { force: true })
      }
    } catch {
      /* 清理失败不阻断 */
    }
  }

  private async completeJob(
    state: GroupState,
    session: SftpSession,
    job: Job,
    partTarget: string
  ): Promise<void> {
    if (state.cancelled || state.paused) throw markAborted(new Error('传输已中断'))
    const upload = state.group.direction === 'upload'
    const delta = job.size - job.transferred
    if (delta > 0) state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
    job.transferred = job.size
    await this.applyFileAttributes(state, session, job, upload, partTarget)
    if (state.cancelled || state.paused) throw markAborted(new Error('传输已中断'))
    await this.finalizeTarget(session, upload, partTarget, job.target)
  }

  private async finalizeTarget(
    session: SftpSession,
    upload: boolean,
    source: string,
    target: string
  ): Promise<void> {
    if (upload) await session.finalizeTransfer(source, target)
    else {
      await replaceWithRollback(source, target, {
        rename: (from, to) => fs.rename(from, to),
        exists: localLexists,
        remove: (file) => fs.rm(file, { recursive: true, force: true })
      })
    }
  }

  private async runJob(state: GroupState, session: SftpSession, job: Job): Promise<void> {
    const upload = state.group.direction === 'upload'
    const partTarget = partOf(job.target)

    await this.syncSourceStats(state, session, job)

    const targetStats = upload
      ? await session.lstat(job.target).catch(() => undefined)
      : await fs.lstat(job.target).catch(() => undefined)
    if (targetStats && typeFromMode(targetStats.mode) === 'directory' && state.resolution !== 'overwrite') {
      throw new Error(`目标为目录，无法写入: ${job.target}（请选择覆盖后重试）`)
    }

    let useResume = state.options.resume && (state.resumeConflicts || job.attempted === true)
    if (job.sourceChanged) useResume = false

    let offset = 0
    if (useResume) {
      const partSize = upload ? await this.remoteSize(session, partTarget) : await localSize(partTarget)
      if (!upload && job.parallel && partSize !== null) {
        const requiredSize = Math.max(
          job.parallel.base,
          ...job.parallel.segments.map((segment) => segment.written > 0 ? segment.start + segment.written : 0)
        )
        if (partSize >= requiredSize && partSize <= job.size) {
          offset = job.parallel.base
        } else {
          useResume = false
        }
      } else if (partSize !== null) {
        job.parallel = undefined
        const plan = resolveResumeOffset(job.size, partSize)
        const match = partSize <= job.size && await this.verifyResumePrefix(
          state, session, job, upload, partTarget, plan.offset
        )
        if (match) {
          offset = plan.offset
          if (plan.complete) {
            await this.completeJob(state, session, job, partTarget)
            return
          }
        } else {
          useResume = false
        }
      } else {
        job.parallel = undefined
        const legacySize = upload
          ? await this.remoteSize(session, job.target)
          : await localSize(job.target)
        if (legacySize === null || legacySize > job.size) {
          useResume = false
        } else {
          const plan = resolveResumeOffset(job.size, legacySize)
          const match = await this.verifyResumePrefix(
            state, session, job, upload, job.target, plan.offset
          )
          if (match && plan.complete) {
            const delta = job.size - job.transferred
            if (delta > 0) state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
            job.transferred = job.size
            await this.applyFileAttributes(state, session, job, upload, job.target)
            return
          }
          if (match && await this.moveToPart(session, upload, job.target)) {
            offset = plan.offset
          } else {
            useResume = false
          }
        }
      }
    }

    if (!useResume) {
      job.parallel = undefined
      offset = 0
      await this.discardPartial(session, upload, job.target)
    }

    const remaining = job.size - offset
    if (
      !upload &&
      (job.parallel || (state.options.concurrency > 1 && remaining >= PARALLEL_MIN_BYTES))
    ) {
      await this.downloadParallel(state, session, job, partTarget, offset)
    } else {
      const delta = offset - job.transferred
      job.transferred = offset
      state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
      job.speed = 0
      job.speedAt = Date.now()
      job.speedBytes = job.transferred
      await this.downloadOrUploadStream(state, session, job, partTarget, offset, upload)
    }

    const finalSize = upload
      ? await this.remoteSize(session, partTarget)
      : await localSize(partTarget)
    if (finalSize !== job.size) {
      throw new Error(`文件大小校验失败 (${finalSize ?? '?'} / ${job.size} 字节)`)
    }
    await this.completeJob(state, session, job, partTarget)
  }

  private async downloadOrUploadStream(
    state: GroupState,
    session: SftpSession,
    job: Job,
    partTarget: string,
    offset: number,
    upload: boolean
  ): Promise<void> {
    const reader: NodeJS.ReadableStream & { destroy: (err?: Error) => void } = upload
      ? createReadStream(job.source, offset > 0 ? { start: offset } : undefined)
      : session.createReadStream(job.source, {
          start: offset > 0 ? offset : undefined,
          highWaterMark: PARALLEL_READ_HWM
        })
    const writer: NodeJS.WritableStream & { destroy: (err?: Error) => void } = upload
      ? session.createWriteStream(partTarget, offset > 0 ? 'a' : 'w')
      : createWriteStream(partTarget, {
          flags: offset > 0 ? 'a' : 'w',
          highWaterMark: PARALLEL_WRITE_HWM
        })

    let aborted = false
    const abort = (): void => {
      aborted = true
      reader.destroy(new Error('传输已中断'))
      writer.destroy(new Error('传输已中断'))
    }
    state.aborts.add(abort)
    try {
      await pipeline(reader as never, this.progress(state, job), writer as never)
    } catch (err) {
      throw aborted ? markAborted(err) : err
    } finally {
      state.aborts.delete(abort)
    }
  }

  private async downloadParallel(
    state: GroupState,
    session: SftpSession,
    job: Job,
    partTarget: string,
    offset: number
  ): Promise<void> {
    if (!job.parallel) {
      if (offset === 0) await fs.writeFile(partTarget, Buffer.alloc(0))
      job.parallel = {
        base: offset,
        segments: planParallelSegments(job.size, offset, state.options.concurrency)
      }
    }
    const { base, segments } = job.parallel

    const confirmed = base + segments.reduce((sum, segment) => sum + segment.written, 0)
    const delta = confirmed - job.transferred
    job.transferred = confirmed
    state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
    job.speed = 0
    job.speedAt = Date.now()
    job.speedBytes = job.transferred

    const streams = new Set<{
      reader: NodeJS.ReadableStream & { destroy: (err?: Error) => void }
      writer: NodeJS.WritableStream & { destroy: (err?: Error) => void }
    }>()
    let cursor = 0
    let failure: Error | null = null
    let aborted = false

    const abortAll = (): void => {
      aborted = true
      for (const pair of streams) {
        pair.reader.destroy(new Error('传输已中断'))
        pair.writer.destroy(new Error('传输已中断'))
      }
    }
    state.aborts.add(abortAll)

    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure || aborted || state.cancelled || state.paused) return
        const segment = segments[cursor++]
        if (!segment) return
        const length = segment.end - segment.start
        if (segment.written >= length) continue
        const from = segment.start + segment.written
        const reader = session.createReadStream(job.source, {
          start: from,
          end: segment.end - 1,
          highWaterMark: PARALLEL_READ_HWM
        })
        const writer = createWriteStream(partTarget, {
          flags: 'r+',
          start: from,
          highWaterMark: PARALLEL_WRITE_HWM
        })
        const pair = { reader, writer }
        streams.add(pair)
        try {
          await pipeline(reader as never, this.progress(state, job), writer as never)
          if (writer.bytesWritten !== length - segment.written) {
            throw new Error('分段大小校验失败')
          }
          segment.written = length
        } catch (err) {
          const persisted = Math.max(0, Math.min(length - segment.written, writer.bytesWritten))
          segment.written += persisted
          if (aborted || state.cancelled || state.paused) return
          failure = failure ?? (err instanceof Error ? err : new Error(String(err)))
          abortAll()
          return
        } finally {
          streams.delete(pair)
        }
      }
    }

    try {
      await Promise.all(segments.map(() => worker()))
    } finally {
      state.aborts.delete(abortAll)
    }

    if (failure) throw failure
    if (state.cancelled || aborted || state.paused) {
      throw markAborted(new Error('传输已中断'))
    }
  }

  private async remoteSize(session: SftpSession, target: string): Promise<number | null> {
    try {
      const stats = await session.lstat(target)
      if (typeFromMode(stats.mode) === 'symlink') return null
      return stats.size
    } catch {
      return null
    }
  }

  private async applyFileAttributes(
    state: GroupState,
    session: SftpSession,
    job: Job,
    upload: boolean,
    targetPath: string
  ): Promise<void> {
    const { preservePermissions, preserveTimestamps } = state.options
    if (!preservePermissions && !preserveTimestamps) return
    try {
      if (preservePermissions && job.mode) {
        if (upload) await session.chmodEntry(targetPath, job.mode & PERMISSION_MASK)
        else await fs.chmod(targetPath, job.mode & PERMISSION_MASK)
      }
      if (preserveTimestamps && job.mtime) {
        const atime = Math.floor(job.atime ?? job.mtime)
        const mtime = Math.floor(job.mtime)
        if (upload) await session.utimes(targetPath, atime, mtime)
        else await fs.utimes(targetPath, atime, mtime)
      }
    } catch {
      /* 属性设置失败不阻断传输 */
    }
  }

  private async applyDirAttributes(state: GroupState, session: SftpSession): Promise<void> {
    const { preservePermissions, preserveTimestamps } = state.options
    if (!preservePermissions && !preserveTimestamps) return
    const upload = state.group.direction === 'upload'
    const dirs = [...state.dirs].sort((a, b) => b.path.length - a.path.length)
    for (const dir of dirs) {
      try {
        if (preservePermissions && dir.mode) {
          if (upload) await session.chmodEntry(dir.path, dir.mode & PERMISSION_MASK)
          else await fs.chmod(dir.path, dir.mode & PERMISSION_MASK)
        }
        if (preserveTimestamps && dir.mtime) {
          const atime = Math.floor(dir.atime ?? dir.mtime)
          const mtime = Math.floor(dir.mtime)
          if (upload) await session.utimes(dir.path, atime, mtime)
          else await fs.utimes(dir.path, atime, mtime)
        }
      } catch {
        /* 属性设置失败不阻断传输 */
      }
    }
  }

  private progress(state: GroupState, job: Job): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        job.transferred += chunk.length
        state.group.transferredBytes += chunk.length
        callback(null, chunk)
      }
    })
  }

  private flush(state: GroupState): void {
    const now = Date.now()
    const elapsed = (now - state.lastFlush) / 1000
    const bytes = state.group.transferredBytes
    if (elapsed > 0) {
      state.group.speed = Math.max(0, (bytes - state.lastBytes) / elapsed)
      state.lastFlush = now
      state.lastBytes = bytes
    }
    if (state.group.status === 'active') {
      for (const job of state.active) {
        const sampleElapsed = (now - job.speedAt) / 1000
        if (sampleElapsed > 0) {
          job.speed = Math.max(0, (job.transferred - job.speedBytes) / sampleElapsed)
          job.speedAt = now
          job.speedBytes = job.transferred
        }
      }
      this.emit(state)
    }
  }

  private activeFiles(state: GroupState): TransferFileProgress[] {
    return [...state.active]
      .sort((a, b) => a.id - b.id)
      .map((job) => ({
        id: job.id,
        name: posixBasename(job.source),
        path: job.source,
        size: job.size,
        transferred: job.transferred,
        speed: job.speed
      }))
  }

  private emit(state: GroupState): void {
    const payload: TransferGroup = { ...state.group, activeFiles: this.activeFiles(state) }
    this.getWebContents()?.send(IPC.evtTransferUpdate, payload)
  }
}
