import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { typeFromMode } from '@shared/format'
import { isTransientFile, isWithin, posixBasename, posixDirname, posixJoin, posixRelative } from '@shared/path'
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

const MAX_CONCURRENT_FILES = 8
const DEFAULT_FILE_CONCURRENCY = 3
const FLUSH_INTERVAL_MS = 300
const CONFLICT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_DEPTH = 128
const WALK_CONCURRENCY = 16
const RETRY_DELAY_MS = 2000
const PERMISSION_MASK = 0o7777
export const MAX_PARALLEL_CHUNKS = 16
export const PARALLEL_MIN_BYTES = 8 * 1024 * 1024
export const PARALLEL_MIN_SEGMENT = 4 * 1024 * 1024
const PARALLEL_READ_HWM = 256 * 1024
const PARALLEL_WRITE_HWM = 256 * 1024
const PART_SUFFIX = '.filetrans-part'
const MAX_BASENAME_BYTES = 255
const RESUME_VERIFY_BYTES = 256 * 1024
const RESUME_VERIFY_FULL_LIMIT = 8 * 1024 * 1024
const RESUME_VERIFY_SAMPLES = 8
const MAX_FINISHED_GROUPS = 50
const MAX_REPORTED_FAILURES = 50

const DEFAULT_OPTIONS: TransferOptions = {
  resume: true,
  retries: 2,
  concurrency: 8,
  fileConcurrency: DEFAULT_FILE_CONCURRENCY,
  preserveTimestamps: true,
  preservePermissions: true
}

function clampConcurrency(value: unknown): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_OPTIONS.concurrency
  return Math.min(parsed, MAX_PARALLEL_CHUNKS)
}

function clampFileConcurrency(value: unknown): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_FILE_CONCURRENCY
  return Math.min(parsed, MAX_CONCURRENT_FILES)
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
  id: number
  linkPath: string
  target: string
}

interface Collected {
  jobs: Job[]
  dirs: DirJob[]
  links: LinkJob[]
}

interface JobFailure {
  id: number
  source: string
  error: string
}

interface ScopeRoot {
  sourceRoot: string
  destRoot: string
}

interface WalkContext {
  roots: ScopeRoot[]
  visited: Set<string>
}

interface RemoteWalkTask {
  remote: string
  local: string
  depth: number
}

interface GroupState {
  group: TransferGroup
  options: TransferOptions
  request: TransferStartRequest
  session: SftpSession
  resolution?: ConflictResolution
  jobs: Job[]
  dirs: DirJob[]
  links: LinkJob[]
  collecting: boolean
  active: Set<Job>
  cursor: number
  cancelled: boolean
  paused: boolean
  resumeConflicts: boolean
  resumeTargets: Set<string>
  error?: Error
  failures: JobFailure[]
  failureCount: number
  skips: JobFailure[]
  skipCount: number
  aborts: Set<() => void>
  pauseWaiters: Set<() => void>
  sidecarQueues: Map<string, Promise<void>>
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
  mtime: number
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

export interface SequentialPartState {
  sequential: true
  size: number
  mtime: number
}

export type PartSidecarState = SequentialPartState | ParallelState

function sidecarOf(target: string): string {
  const sidecar = `${target}${PART_SUFFIX}.json`
  if (Buffer.byteLength(posixBasename(sidecar)) <= MAX_BASENAME_BYTES) return sidecar
  return `${joinDirName(posixDirname(target), shortPartName(target))}.json`
}

export function validateParallelState(size: number, partSize: number, state: ParallelState): boolean {
  if (!Number.isFinite(state.base) || state.base < 0 || state.base > size) return false
  if (!Array.isArray(state.segments)) return false
  let cursor = state.base
  let required = state.base
  for (const segment of state.segments) {
    if (!segment || segment.start !== cursor) return false
    if (!(segment.end > segment.start) || segment.end > size) return false
    if (!Number.isInteger(segment.written) || segment.written < 0) return false
    if (segment.written > segment.end - segment.start) return false
    if (segment.written > 0) required = Math.max(required, segment.start + segment.written)
    cursor = segment.end
  }
  if (cursor !== size) return false
  return partSize >= required && partSize <= size
}

function isSequentialPartState(value: unknown): value is SequentialPartState {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as SequentialPartState).sequential === true &&
    Number.isFinite((value as SequentialPartState).size) &&
    (value as SequentialPartState).size >= 0 &&
    Number.isFinite((value as SequentialPartState).mtime)
  )
}

function isParallelState(value: unknown): value is ParallelState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as ParallelState
  return (
    Number.isFinite(state.base) &&
    Number.isFinite(state.mtime) &&
    Array.isArray(state.segments) &&
    state.segments.every(
      (segment) =>
        segment !== null &&
        typeof segment === 'object' &&
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        Number.isInteger(segment.written) &&
        segment.written >= 0
    )
  )
}

export interface ResumeVerifyRange {
  start: number
  end: number
}

export function planResumeVerify(offset: number): ResumeVerifyRange[] {
  if (offset <= 0) return []
  const blocks = Math.ceil(offset / RESUME_VERIFY_BYTES)
  const indices: number[] = []
  if (offset <= RESUME_VERIFY_FULL_LIMIT) {
    for (let index = 0; index < blocks; index++) indices.push(index)
  } else {
    for (let sample = 0; sample < RESUME_VERIFY_SAMPLES; sample++) {
      indices.push(Math.round((sample * (blocks - 1)) / (RESUME_VERIFY_SAMPLES - 1)))
    }
  }
  const unique = [...new Set(indices)].sort((a, b) => a - b)
  return unique.map((index) => {
    const start = index * RESUME_VERIFY_BYTES
    return { start, end: Math.min(offset, start + RESUME_VERIFY_BYTES) - 1 }
  })
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

function shortPartName(target: string): string {
  const hash = createHash('sha1').update(target).digest('hex').slice(0, 16)
  return `.ft-${hash}.filetrans-part`
}

function joinDirName(dir: string, name: string): string {
  if (!dir || dir === '.') return name
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function caseFoldCollisions(targets: readonly string[]): Map<number, string> {
  const seen = new Map<string, string>()
  const collisions = new Map<number, string>()
  targets.forEach((target, index) => {
    const key = target.normalize('NFC').toLowerCase()
    const kept = seen.get(key)
    if (kept === undefined) seen.set(key, target)
    else collisions.set(index, kept)
  })
  return collisions
}

export async function localCaseInsensitive(dir: string): Promise<boolean> {
  const name = `.ft-${randomUUID().replace(/-/g, '').slice(0, 16)}.filetrans-part`
  const probe = path.join(dir, name)
  try {
    await fs.writeFile(probe, '', { flag: 'wx' })
  } catch {
    return false
  }
  try {
    await fs.stat(path.join(dir, name.toUpperCase()))
    return true
  } catch {
    return false
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined)
  }
}

function partOf(target: string): string {
  const part = `${target}${PART_SUFFIX}`
  if (Buffer.byteLength(posixBasename(part)) <= MAX_BASENAME_BYTES) return part
  return joinDirName(posixDirname(target), shortPartName(target))
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
  target: string,
  start: number,
  end: number
): Promise<Buffer | null> {
  const reader = state.session.createReadStream(target, {
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
  private conflictTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private getWebContents: () => WebContents | null,
    private sessions: SessionManager
  ) {}

  async start(req: TransferStartRequest): Promise<string> {
    const session = this.sessions.get(req.sessionId)
    if (req.sources.length === 0) throw new Error('没有选择文件')

    const options: TransferOptions = { ...DEFAULT_OPTIONS, ...req.options }
    options.concurrency = clampConcurrency(options.concurrency)
    options.fileConcurrency = clampFileConcurrency(options.fileConcurrency)
    options.retries = Math.max(0, Math.min(10, Math.floor(Number(options.retries)) || 0))
    const id = randomUUID()
    const label =
      req.sources.length === 1 ? posixBasename(req.sources[0]) : `${req.sources.length} 个项目`
    const group: TransferGroup = {
      id,
      sessionId: req.sessionId,
      direction: req.direction,
      sourceLabel: label,
      targetDir: req.targetDir,
      status: 'pending',
      totalFiles: 0,
      doneFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      retryCount: 0,
      startedAt: Date.now(),
      collecting: true
    }
    const now = Date.now()
    const state: GroupState = {
      group,
      options,
      request: req,
      session,
      jobs: [],
      dirs: [],
      links: [],
      collecting: true,
      active: new Set(),
      cursor: 0,
      cancelled: false,
      paused: false,
      resumeConflicts: false,
      resumeTargets: new Set(),
      failures: [],
      failureCount: 0,
      skips: [],
      skipCount: 0,
      aborts: new Set(),
      pauseWaiters: new Set(),
      sidecarQueues: new Map(),
      flushTimer: setInterval(() => this.flush(state), FLUSH_INTERVAL_MS),
      lastFlush: now,
      lastBytes: 0
    }
    this.groups.set(id, state)
    this.emit(state)
    void this.run(state).catch(() => undefined)
    return id
  }

  private async collectJobs(state: GroupState): Promise<void> {
    const session = state.session
    const req = state.request
    const collected =
      req.direction === 'upload'
        ? await this.collectUploadJobs(req.sources, req.targetDir, req.recursive, state)
        : await this.collectDownloadJobs(session, req.sources, req.targetDir, req.recursive, state)
    if (state.cancelled) throw new Error('传输已取消')
    if (collected.jobs.length === 0 && collected.dirs.length === 0 && collected.links.length === 0) {
      throw new Error('没有可传输的文件')
    }

    const seenTargets = new Set<string>()
    const duplicates: string[] = []
    collected.jobs = collected.jobs.filter((job) => {
      if (seenTargets.has(job.target)) {
        duplicates.push(job.target)
        return false
      }
      seenTargets.add(job.target)
      return true
    })
    collected.links = collected.links.filter((link) => {
      if (seenTargets.has(link.linkPath)) {
        duplicates.push(link.linkPath)
        return false
      }
      seenTargets.add(link.linkPath)
      return true
    })
    for (const duplicate of duplicates) {
      this.recordSkip(state, duplicate, `目标路径重复，已跳过: ${duplicate}`)
    }
    if (req.direction === 'download' && (await localCaseInsensitive(req.targetDir))) {
      const folded = [
        ...collected.jobs.map((job) => job.target),
        ...collected.links.map((link) => link.linkPath)
      ]
      const collisions = caseFoldCollisions(folded)
      if (collisions.size > 0) {
        const jobCount = collected.jobs.length
        collected.jobs = collected.jobs.filter((_, index) => !collisions.has(index))
        collected.links = collected.links.filter((_, index) => !collisions.has(jobCount + index))
        for (const [index, kept] of collisions) {
          this.recordSkip(
            state,
            folded[index],
            `目标文件系统不区分大小写，与 ${kept} 冲突，已跳过: ${folded[index]}`
          )
        }
      }
    }

    let jobs = collected.jobs
    let links = collected.links

    const targets = [...jobs.map((job) => job.target), ...links.map((link) => link.linkPath)]
    const conflicts = await this.probeConflicts(state, targets)
    if (state.cancelled) throw new Error('传输已取消')
    if (!session.connected || !state.session.connected) {
      throw new Error('连接已断开，目录展开与冲突检测未完成')
    }

    if (conflicts.length > 0) {
      const resolution = await this.askConflict(state.group.id, conflicts)
      if (resolution === 'cancel') {
        state.cancelled = true
        return
      }
      if (resolution === 'skip') {
        const skippedConflicts = conflicts.filter((conflict) => conflict.partial !== true)
        const skipSet = new Set(skippedConflicts.map((conflict) => conflict.targetPath))
        jobs = jobs.filter((job) => !skipSet.has(job.target))
        links = links.filter((link) => !skipSet.has(link.linkPath))
        await this.cleanupParts(
          session,
          req.direction,
          skippedConflicts.map((conflict) => conflict.targetPath)
        )
        for (const conflict of skippedConflicts) {
          this.recordSkip(state, conflict.targetPath, `目标已存在，已跳过: ${conflict.targetPath}`)
        }
      }
      state.resumeConflicts = resolution === 'resume'
      state.resumeTargets = new Set(
        resolution === 'skip'
          ? conflicts.filter((conflict) => conflict.partial === true).map((conflict) => conflict.targetPath)
          : []
      )
      state.resolution = resolution
      if (resolution === 'overwrite') {
        await this.cleanupParts(
          session,
          req.direction,
          conflicts.map((conflict) => conflict.targetPath)
        )
      }
    }

    jobs.forEach((job, index) => {
      job.id = index
    })
    links.forEach((link, index) => {
      link.id = jobs.length + index
    })
    state.jobs = jobs
    state.dirs = collected.dirs
    state.links = links
    state.group.totalFiles = jobs.length + links.length
    state.group.totalBytes = jobs.reduce((sum, job) => sum + job.size, 0)
  }

  private async probeConflicts(state: GroupState, targets: string[]): Promise<ConflictItem[]> {
    const session = state.session
    const isUpload = state.group.direction === 'upload'
    const probed: Array<ConflictItem | undefined> = new Array(targets.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (state.cancelled) return
        const index = cursor++
        if (index >= targets.length) return
        const target = targets[index]
        const part = partOf(target)
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
        if (!info) continue
        const type = typeFromMode(info.mode)
        probed[index] = {
          targetPath: target,
          size: info.size ?? 0,
          type: type === 'directory' ? 'directory' : type === 'symlink' ? 'symlink' : 'file',
          partial: finalStats === undefined
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WALK_CONCURRENCY, targets.length) }, () => worker())
    )
    return probed.filter((item): item is ConflictItem => item !== undefined)
  }

  cancel(id: string): void {
    const state = this.groups.get(id)
    if (!state) return
    state.cancelled = true
    for (const abort of state.aborts) abort()
    this.releasePauseWaiters(state)
    this.settleConflict(id, 'cancel')
    this.emit(state)
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
    if (state.session && state.session.connected === false) {
      const params = state.session.params
      const replacement = params ? this.sessions.findByParams(params) : undefined
      if (replacement && replacement.connected) {
        state.session = replacement
        state.group.sessionId = replacement.id
        state.group.error = undefined
      } else {
        state.group.error = '连接已断开，重新连接站点后可继续传输'
        this.emit(state)
        return
      }
    }
    state.paused = false
    if (state.group.status === 'paused') state.group.status = 'active'
    this.releasePauseWaiters(state)
    this.emit(state)
  }

  resolveConflict(id: string, resolution: ConflictResolution): void {
    this.settleConflict(id, resolution)
  }

  private settleConflict(id: string, resolution: ConflictResolution): void {
    const waiter = this.conflictWaiters.get(id)
    if (!waiter) return
    const timer = this.conflictTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.conflictTimers.delete(id)
    }
    this.conflictWaiters.delete(id)
    this.conflictItems.delete(id)
    this.getWebContents()?.send(IPC.evtConflictExpired, id)
    waiter(resolution)
    const nextId = [...this.conflictWaiters.keys()][0]
    if (nextId) this.armConflictTimer(nextId)
  }

  private armConflictTimer(transferId: string): void {
    if (this.conflictTimers.has(transferId)) return
    const head = [...this.conflictWaiters.keys()][0]
    if (head !== transferId) return
    const timer = setTimeout(() => this.settleConflict(transferId, 'cancel'), CONFLICT_TIMEOUT_MS)
    this.conflictTimers.set(transferId, timer)
  }

  handleSessionClosed(sessionId: string): void {
    for (const state of this.groups.values()) {
      if (state.session.id !== sessionId) continue
      if (
        !state.collecting &&
        state.group.status !== 'active' &&
        state.group.status !== 'paused' &&
        state.group.status !== 'pending'
      ) {
        continue
      }
      state.paused = true
      if (!state.collecting && state.group.status !== 'paused') {
        state.group.status = 'paused'
      }
      state.group.error = '连接已断开，任务已暂停'
      for (const abort of state.aborts) abort()
      for (const job of state.active) job.speed = 0
      this.emit(state)
    }
  }

  clearFinished(): void {
    for (const [id, state] of this.groups) {
      const status = state.group.status
      if (status === 'done' || status === 'error' || status === 'cancelled') {
        this.groups.delete(id)
      }
    }
  }

  hasActiveTransferUnder(dirPrefix: string, scope: 'local' | 'remote'): boolean {
    const prefix = dirPrefix.endsWith('/') ? dirPrefix : `${dirPrefix}/`
    for (const state of this.groups.values()) {
      const status = state.group.status
      if (status !== 'active' && status !== 'pending' && status !== 'paused') continue
      if ((scope === 'local') !== (state.group.direction === 'download')) continue
      for (const job of state.active) {
        if (job.target === dirPrefix || job.target.startsWith(prefix)) return true
      }
    }
    return false
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
      this.conflictItems.set(transferId, items)
      this.conflictWaiters.set(transferId, (resolution) => {
        resolve(resolution)
      })
      this.armConflictTimer(transferId)
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
          await fs.rm(sidecarOf(target), { force: true })
        }
      } catch {
        /* 清理残留临时文件失败不阻断 */
      }
    }
  }

  private async collectUploadJobs(
    sources: string[],
    targetDir: string,
    recursive: boolean,
    state: GroupState
  ): Promise<Collected> {
    const collected: Collected = { jobs: [], dirs: [], links: [] }
    const ctx: WalkContext = { roots: [], visited: new Set() }
    const pendingWalks: Array<{ source: string; target: string }> = []

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
        pendingWalks.push({ source, target })
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
        this.recordSkip(state, source, `不支持的文件类型，已跳过: ${source}`)
      }
    }
    for (const walk of pendingWalks) {
      await this.walkLocal(walk.source, walk.target, ctx, collected, 0, state)
    }
    return collected
  }

  private async walkLocal(
    dir: string,
    remoteDir: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number,
    state: GroupState
  ): Promise<void> {
    if (depth > MAX_DEPTH) {
      this.recordSkip(state, dir, `目录层级超过 ${MAX_DEPTH} 层，已跳过: ${dir}`)
      return
    }
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (depth === 0) throw err
      const message = err instanceof Error ? err.message : String(err)
      this.recordSkip(state, dir, `无法读取目录 ${dir}: ${message}`)
      return
    }
    const stats = await Promise.all(
      dirents.map((dirent) => {
        if (!dirent.isDirectory() && !dirent.isFile()) return Promise.resolve(null)
        return fs.lstat(path.join(dir, dirent.name)).catch(() => null)
      })
    )
    for (const [index, dirent] of dirents.entries()) {
      if (isTransientFile(dirent.name)) continue
      const full = path.join(dir, dirent.name)
      const remote = posixJoin(remoteDir, dirent.name)
      if (dirent.isSymbolicLink()) {
        await this.handleLocalSymlink(full, remote, ctx, collected, depth, state)
      } else if (dirent.isDirectory() || dirent.isFile()) {
        const entryStats = stats[index]
        if (!entryStats) {
          this.recordSkip(state, full, `无法读取文件信息，已跳过: ${full}`)
          continue
        }
        if (dirent.isDirectory()) {
          collected.dirs.push({ path: remote, ...localAttributes(entryStats) })
          await this.walkLocal(full, remote, ctx, collected, depth + 1, state)
        } else {
          collected.jobs.push(
            makeJob({
              source: full,
              target: remote,
              size: entryStats.size,
              transferred: 0,
              ...localAttributes(entryStats)
            })
          )
        }
      }
    }
  }

  private async handleLocalSymlink(
    linkPath: string,
    remoteLinkPath: string,
    ctx: WalkContext,
    collected: Collected,
    depth: number,
    state: GroupState
  ): Promise<void> {
    let linkTarget: string | undefined
    try {
      linkTarget = await fs.readlink(linkPath)
    } catch {
      this.recordSkip(state, linkPath, `无法读取符号链接，已跳过: ${linkPath}`)
      return
    }
    const resolved = await fs.realpath(linkPath).catch(() => undefined)

    if (resolved) {
      const root = findScope(ctx.roots, resolved)
      if (root) {
        const relative = path.relative(root.sourceRoot, resolved).split(path.sep).join('/')
        const remoteTarget = posixJoin(root.destRoot, relative)
        collected.links.push({
          id: 0,
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
          collected.links.push({ id: 0, linkPath: remoteLinkPath, target: linkTarget })
          return
        }
        ctx.visited.add(resolved)
        collected.dirs.push({ path: remoteLinkPath, ...localAttributes(stats) })
        await this.walkLocal(linkPath, remoteLinkPath, ctx, collected, depth + 1, state)
        return
      }
    }
    collected.links.push({ id: 0, linkPath: remoteLinkPath, target: linkTarget })
  }

  private async collectDownloadJobs(
    session: SftpSession,
    sources: string[],
    targetDir: string,
    recursive: boolean,
    state: GroupState
  ): Promise<Collected> {
    const collected: Collected = { jobs: [], dirs: [], links: [] }
    const ctx: WalkContext = { roots: [], visited: new Set() }
    const tasks: RemoteWalkTask[] = []

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
        tasks.push({ remote: source, local: target, depth: 0 })
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
    if (tasks.length > 0) {
      await this.walkRemoteTree(session, tasks, ctx, collected, state)
    }
    return collected
  }

  private async walkRemoteTree(
    session: SftpSession,
    tasks: RemoteWalkTask[],
    ctx: WalkContext,
    collected: Collected,
    state: GroupState
  ): Promise<void> {
    const scheduled = new Set(tasks.map((task) => task.remote))
    let failure: Error | null = null
    let activeCount = 0
    const waiters: Array<() => void> = []
    const acquire = (): Promise<void> =>
      new Promise((resolve) => {
        if (activeCount < WALK_CONCURRENCY) {
          activeCount++
          resolve()
          return
        }
        waiters.push(() => {
          activeCount++
          resolve()
        })
      })
    const release = (): void => {
      const next = waiters.shift()
      if (next) next()
      else activeCount--
    }

    const runTask = async (task: RemoteWalkTask): Promise<void> => {
      let children: Array<Promise<void>> = []
      await acquire()
      try {
        if (!failure && !state.cancelled) {
          if (task.depth <= MAX_DEPTH) {
            const listing = await session.list(task.remote)
            for (const entry of listing.entries) {
              const local = path.join(task.local, entry.name)
              const nameValid =
                entry.name !== '' &&
                entry.name !== '.' &&
                entry.name !== '..' &&
                !entry.name.includes('/') &&
                !entry.name.includes('\0')
              if (!nameValid || !isWithin(task.local, local)) {
                this.recordSkip(
                  state,
                  entry.path,
                  `服务器返回了非法或越界的文件名 ${entry.name}，已跳过`
                )
                continue
              }
              if (entry.isSymlink) {
                const next = await this.handleRemoteSymlink(
                  session, entry.path, local, task.depth, ctx, collected, scheduled
                )
                if (next) children.push(runTask(next))
              } else if (entry.type === 'directory') {
                if (scheduled.has(entry.path)) continue
                scheduled.add(entry.path)
                collected.dirs.push({ path: local, ...entryAttributes(entry) })
                children.push(runTask({ remote: entry.path, local, depth: task.depth + 1 }))
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
          } else {
            this.recordSkip(
              state,
              task.remote,
              `目录层级超过 ${MAX_DEPTH} 层，已跳过: ${task.remote}`
            )
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (task.depth === 0 || !session.connected) {
          failure = failure ?? error
        } else {
          this.recordSkip(state, task.remote, `无法读取目录 ${task.remote}: ${error.message}`)
        }
      } finally {
        release()
      }
      if (children.length > 0) await Promise.all(children)
    }

    try {
      await Promise.all(tasks.map(runTask))
    } finally {
      if (failure) throw failure
    }
  }

  private async handleRemoteSymlink(
    session: SftpSession,
    remoteLinkPath: string,
    localLinkPath: string,
    depth: number,
    ctx: WalkContext,
    collected: Collected,
    scheduled: Set<string>
  ): Promise<RemoteWalkTask | null> {
    const linkTarget = await session.readlink(remoteLinkPath).catch(() => undefined)
    const resolved = await session.realpath(remoteLinkPath).catch(() => undefined)

    if (resolved) {
      const root = findScope(ctx.roots, resolved)
      if (root) {
        const relative = posixRelative(root.sourceRoot, resolved)
        const localTarget = path.join(root.destRoot, relative)
        collected.links.push({
          id: 0,
          linkPath: localLinkPath,
          target:
            linkTarget && path.isAbsolute(linkTarget)
              ? localTarget
              : path.relative(path.dirname(localLinkPath), localTarget)
        })
        return null
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
        return null
      }
      if (stats && type === 'directory') {
        if (ctx.visited.has(resolved)) {
          if (linkTarget) collected.links.push({ id: 0, linkPath: localLinkPath, target: linkTarget })
          return null
        }
        ctx.visited.add(resolved)
        collected.dirs.push({ path: localLinkPath, ...remoteAttributes(stats) })
        if (!scheduled.has(remoteLinkPath)) {
          scheduled.add(remoteLinkPath)
          return { remote: remoteLinkPath, local: localLinkPath, depth: depth + 1 }
        }
        return null
      }
    }
    if (linkTarget) collected.links.push({ id: 0, linkPath: localLinkPath, target: linkTarget })
    return null
  }

  private async run(state: GroupState): Promise<void> {
    const group = state.group
    this.emit(state)
    try {
      if (state.collecting) {
        for (;;) {
          const attemptSession = state.session
          try {
            await this.collectJobs(state)
            break
          } catch (err) {
            if (state.cancelled) throw new Error('传输已取消')
            if (attemptSession.connected && !state.paused) throw err
            this.resetSkips(state)
            if (!state.session.connected) this.pauseForLostSession(state)
            if (state.paused) {
              if (state.group.status !== 'paused') state.group.status = 'paused'
              this.emit(state)
              await this.waitWhilePaused(state)
            }
          }
        }
        state.collecting = false
        group.collecting = false
        if (state.cancelled) throw new Error('传输已取消')
      }
      group.status = state.paused ? 'paused' : 'active'
      this.emit(state)
      const deadJobs = new Set<number>()
      const byDepth = new Map<number, DirJob[]>()
      for (const dir of state.dirs) {
        const depth = dir.path.split('/').filter(Boolean).length
        const list = byDepth.get(depth) ?? []
        list.push(dir)
        byDepth.set(depth, list)
      }
      const failures = new Map<DirJob, string>()
      const upload = group.direction === 'upload'
      for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
        let pending = byDepth.get(depth) ?? []
        while (pending.length > 0) {
          if (state.cancelled) break
          await this.waitWhilePaused(state)
          if (state.cancelled) break
          const attemptSession = state.session
          const queue = [...pending]
          const lost: DirJob[] = []
          const dirWorker = async (): Promise<void> => {
            for (;;) {
              if (state.cancelled) return
              const dir = queue.shift()
              if (!dir) return
              try {
                if (upload) await attemptSession.mkdirp(dir.path)
                else await fs.mkdir(dir.path, { recursive: true })
              } catch (err) {
                if (upload && !attemptSession.connected) lost.push(dir)
                else failures.set(dir, err instanceof Error ? err.message : String(err))
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(WALK_CONCURRENCY, queue.length) }, () => dirWorker())
          )
          pending = lost
          if (lost.length > 0 && !state.session.connected) this.pauseForLostSession(state)
        }
        if (state.cancelled) break
      }
      for (const [dir, message] of failures) {
        const prefix = `${dir.path}/`
        for (const job of state.jobs) {
          if (deadJobs.has(job.id)) continue
          if (job.target === dir.path || job.target.startsWith(prefix)) {
            deadJobs.add(job.id)
            this.recordFailure(state, job, `无法创建目录 ${dir.path}: ${message}`)
          }
        }
      }
      for (const link of state.links) {
        if (state.cancelled) break
        await this.waitWhilePaused(state)
        if (state.cancelled) break
        try {
          let attempts = 0
          for (;;) {
            const attemptSession = state.session
            try {
              await this.createSymlink(state, link)
              group.doneFiles++
              break
            } catch (err) {
              if (state.cancelled) break
              if (upload && !attemptSession.connected) {
                if (!state.session.connected) this.pauseForLostSession(state)
                await this.waitWhilePaused(state)
                if (state.cancelled) break
                continue
              }
              if (isAbortedError(err) || attempts >= state.options.retries) throw err
              attempts++
              await delay(RETRY_DELAY_MS)
            }
          }
        } catch (err) {
          if (state.cancelled) break
          this.recordFailure(
            state,
            { id: link.id, source: link.linkPath },
            err instanceof Error ? err.message : String(err)
          )
        }
        this.emit(state)
      }
      const workerCount = Math.min(
        state.options.fileConcurrency,
        Math.max(1, state.jobs.length)
      )
      await Promise.all(Array.from({ length: workerCount }, () => this.worker(state, deadJobs)))
      if (!state.cancelled) await this.applyDirAttributes(state)
    } catch (err) {
      if (!state.cancelled) state.error = err instanceof Error ? err : new Error(String(err))
    }
    clearInterval(state.flushTimer)
    if (state.cancelled && !state.error) {
      group.status = 'cancelled'
    } else if (state.error) {
      group.status = 'error'
      group.error = state.error.message
    } else if (state.failureCount > 0) {
      group.status = 'error'
      group.error =
        state.failureCount === 1
          ? `1 个文件失败：${state.failures[0].error}`
          : `${state.failureCount} 个文件失败，首个失败原因：${state.failures[0].error}`
    } else {
      group.status = 'done'
      group.doneFiles = group.totalFiles
      group.transferredBytes = group.totalBytes
    }
    if (state.skipCount > 0) {
      group.warning =
        state.skipCount === 1
          ? `已跳过 1 个项目：${state.skips[0].error}`
          : `已跳过 ${state.skipCount} 个项目，首个原因：${state.skips[0].error}`
    }
    group.speed = 0
    group.finishedAt = Date.now()
    state.jobs = []
    state.dirs = []
    state.links = []
    this.pruneFinished()
    this.emit(state)
  }

  private async createSymlink(state: GroupState, link: LinkJob): Promise<void> {
    const session = state.session
    const upload = state.group.direction === 'upload'
    const existing = upload
      ? await session.lstat(link.linkPath).catch(() => undefined)
      : await fs.lstat(link.linkPath).catch(() => undefined)
    if (existing) {
      const type = typeFromMode(existing.mode)
      if (type === 'directory' && state.resolution !== 'overwrite') {
        throw new Error(`目标为目录，无法创建链接: ${link.linkPath}（请选择覆盖后重试）`)
      }
      if (type !== 'directory' && state.resolution === 'resume') {
        this.recordSkip(state, link.linkPath, `目标已存在同名文件，已跳过链接: ${link.linkPath}`)
        return
      }
    }
    const partTarget = partOf(link.linkPath)
    if (upload) {
      if (await session.lexists(partTarget)) await session.removeEntries([partTarget])
      await session.symlink(link.target, partTarget)
    } else {
      await fs.rm(partTarget, { force: true })
      await fs.symlink(link.target, partTarget)
    }
    if (state.cancelled) return
    await this.finalizeTarget(state, upload, partTarget, link.linkPath)
  }

  private async worker(state: GroupState, deadJobs: Set<number>): Promise<void> {
    for (;;) {
      if (state.cancelled) return
      await this.waitWhilePaused(state)
      if (state.cancelled) return
      const job = state.jobs[state.cursor++]
      if (!job) return
      if (deadJobs.has(job.id)) continue
      state.active.add(job)
      this.emit(state)
      try {
        await this.runJobWithRetry(state, job)
        state.group.doneFiles++
        state.group.retryCount = 0
      } catch (err) {
        if (state.cancelled) return
        state.group.retryCount = 0
        this.recordFailure(state, job, err instanceof Error ? err.message : String(err))
        this.emit(state)
      } finally {
        state.active.delete(job)
      }
    }
  }

  private recordFailure(
    state: GroupState,
    entry: { id: number; source: string },
    message: string
  ): void {
    state.failureCount += 1
    const id = entry.id >= 0 ? entry.id : -state.failureCount
    if (state.failures.length < MAX_REPORTED_FAILURES) {
      state.failures.push({ id, source: entry.source, error: message })
    }
    state.group.failedCount = state.failureCount
    state.group.failedFiles = state.failures.map((failure) => ({
      id: failure.id,
      name: posixBasename(failure.source),
      path: failure.source,
      error: failure.error
    }))
  }

  private pauseForLostSession(state: GroupState): void {
    if (state.paused) return
    state.paused = true
    if (state.group.status === 'active' || state.group.status === 'pending') {
      state.group.status = 'paused'
    }
    state.group.error = '连接已断开，任务已暂停'
    for (const job of state.active) job.speed = 0
    this.emit(state)
  }

  private resetSkips(state: GroupState): void {
    state.skipCount = 0
    state.skips = []
    state.group.skippedCount = undefined
    state.group.skippedFiles = undefined
  }

  private recordSkip(state: GroupState, source: string, reason: string): void {
    state.skipCount += 1
    if (state.skips.length < MAX_REPORTED_FAILURES) {
      state.skips.push({ id: -state.skipCount, source, error: reason })
    }
    state.group.skippedCount = state.skipCount
    state.group.skippedFiles = state.skips.map((skip) => ({
      id: skip.id,
      name: posixBasename(skip.source),
      path: skip.source,
      error: skip.error
    }))
  }

  private throwIfInterrupted(state: GroupState): void {
    if (state.cancelled) throw new Error('传输已取消')
    if (state.paused) throw markAborted(new Error('传输已中断'))
  }

  private async runJobWithRetry(state: GroupState, job: Job): Promise<void> {
    let failures = 0
    for (;;) {
      if (state.cancelled) throw new Error('传输已取消')
      await this.waitWhilePaused(state)
      if (state.cancelled) throw new Error('传输已取消')
      const bytesBefore = job.transferred
      const attemptSession = state.session
      try {
        await this.runJob(state, job)
        return
      } catch (err) {
        if (state.cancelled) throw err
        if (isAbortedError(err)) {
          job.attempted = true
          continue
        }
        if (state.paused || !attemptSession.connected) {
          job.attempted = true
          if (!state.session.connected) this.pauseForLostSession(state)
          continue
        }
        if (job.transferred > bytesBefore) failures = 0
        failures++
        if (failures > state.options.retries) throw err
        job.attempted = true
        state.group.retryCount = failures
        this.emit(state)
        await delay(RETRY_DELAY_MS)
      }
    }
  }

  private async syncSourceStats(state: GroupState, job: Job): Promise<void> {
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
        const stats = await state.session.stat(job.source)
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
    job: Job,
    destPath: string,
    offset: number
  ): Promise<boolean> {
    for (const range of planResumeVerify(offset)) {
      this.throwIfInterrupted(state)
      const length = range.end - range.start + 1
      const source = state.group.direction === 'upload'
        ? await readLocalRange(job.source, range.start, range.end)
        : await readRemoteRange(state, job.source, range.start, range.end)
      if (!source || source.length !== length) {
        throw new Error(`校验续传前缀时读取源文件失败: ${job.source}`)
      }
      const dest = state.group.direction === 'upload'
        ? await readRemoteRange(state, destPath, range.start, range.end)
        : await readLocalRange(destPath, range.start, range.end)
      if (!dest || dest.length !== length) {
        throw new Error(`校验续传前缀时读取目标失败: ${destPath}`)
      }
      if (!source.equals(dest)) return false
    }
    return true
  }

  private async moveToPart(state: GroupState, upload: boolean, target: string): Promise<boolean> {
    const session = state.session
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
        await fs.rm(sidecarOf(target), { force: true })
      }
    } catch {
      /* 清理失败不阻断 */
    }
  }

  private async completeJob(
    state: GroupState,
    job: Job,
    partTarget: string
  ): Promise<void> {
    if (state.cancelled || state.paused) throw markAborted(new Error('传输已中断'))
    const upload = state.group.direction === 'upload'
    const delta = job.size - job.transferred
    if (delta > 0) state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
    job.transferred = job.size
    await this.applyFileAttributes(state, job, upload, partTarget)
    if (state.cancelled || state.paused) throw markAborted(new Error('传输已中断'))
    await this.finalizeTarget(state, upload, partTarget, job.target)
    if (!upload) await this.removePartSidecar(job.target)
  }

  private async finalizeTarget(
    state: GroupState,
    upload: boolean,
    source: string,
    target: string
  ): Promise<void> {
    if (upload) await state.session.finalizeTransfer(source, target)
    else {
      await replaceWithRollback(source, target, {
        rename: (from, to) => fs.rename(from, to),
        exists: localLexists,
        remove: (file) => fs.rm(file, { recursive: true, force: true })
      })
    }
  }

  private async removePartSidecar(target: string): Promise<void> {
    try {
      await fs.rm(sidecarOf(target), { force: true })
    } catch {
      /* 清理失败不阻断 */
    }
  }

  private async readPartSidecar(target: string): Promise<PartSidecarState | undefined> {
    try {
      const raw = await fs.readFile(sidecarOf(target), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isSequentialPartState(parsed)) return parsed
      return isParallelState(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private async writeSidecarAtomic(state: GroupState, target: string, payload: string): Promise<void> {
    const previous = state.sidecarQueues.get(target) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      const sidecar = sidecarOf(target)
      const tmp = path.join(path.dirname(sidecar), `.ft-${randomUUID()}.filetrans-part.json.tmp`)
      try {
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, sidecar)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        throw err
      }
    })
    state.sidecarQueues.set(target, task)
    try {
      await task
    } catch {
      /* 写入失败只影响后续跨会话续传 */
    }
  }

  private async writeSequentialSidecar(job: Job, state: GroupState): Promise<void> {
    await this.writeSidecarAtomic(
      state,
      job.target,
      JSON.stringify({
        sequential: true,
        size: job.size,
        mtime: Math.floor(job.mtime ?? 0)
      } satisfies SequentialPartState)
    )
  }

  private async persistParallelSidecar(job: Job, state: GroupState, partTarget: string): Promise<void> {
    if (!job.parallel) return
    try {
      const handle = await fs.open(partTarget, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch {
      /* 无法 fsync 时旁挂状态可能领先于磁盘，续传前的校验会兜住 */
    }
    await this.writeSidecarAtomic(state, job.target, JSON.stringify(job.parallel))
  }

  private async runJob(state: GroupState, job: Job): Promise<void> {
    const session = state.session
    const upload = state.group.direction === 'upload'
    const partTarget = partOf(job.target)

    await this.syncSourceStats(state, job)
    this.throwIfInterrupted(state)

    const targetStats = upload
      ? await session.lstat(job.target).catch(() => undefined)
      : await fs.lstat(job.target).catch(() => undefined)
    this.throwIfInterrupted(state)
    if (targetStats && typeFromMode(targetStats.mode) === 'directory' && state.resolution !== 'overwrite') {
      throw new Error(`目标为目录，无法写入: ${job.target}（请选择覆盖后重试）`)
    }

    let useResume =
      state.options.resume &&
      (state.resumeConflicts || job.attempted === true || state.resumeTargets.has(job.target))
    if (job.sourceChanged) useResume = false

    let offset = 0
    if (useResume) {
      const partSize = upload ? await this.remoteSize(session, partTarget) : await localSize(partTarget)
      if (!upload && partSize !== null) {
        const restored = job.parallel ?? (await this.readPartSidecar(job.target))
        if (restored === undefined) {
          useResume = false
        } else if ('sequential' in restored) {
          job.parallel = undefined
          if (
            restored.size !== job.size ||
            restored.mtime !== Math.floor(job.mtime ?? 0)
          ) {
            useResume = false
          } else {
            const plan = resolveResumeOffset(job.size, partSize)
            const match =
              partSize <= job.size && (await this.verifyResumePrefix(state, job, partTarget, plan.offset))
            if (match) {
              offset = plan.offset
              if (plan.complete) {
                await this.completeJob(state, job, partTarget)
                return
              }
            } else {
              useResume = false
            }
          }
        } else if (
          restored.mtime === Math.floor(job.mtime ?? 0) &&
          validateParallelState(job.size, partSize, restored)
        ) {
          job.parallel = restored
          offset = restored.base
        } else {
          useResume = false
        }
      } else if (partSize !== null) {
        job.parallel = undefined
        const plan = resolveResumeOffset(job.size, partSize)
        const match = partSize <= job.size && (await this.verifyResumePrefix(
          state, job, partTarget, plan.offset
        ))
        if (match) {
          offset = plan.offset
          if (plan.complete) {
            await this.completeJob(state, job, partTarget)
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
          let targetMtime = -1
          if (targetStats) {
            targetMtime = upload
              ? Math.floor(Number(targetStats.mtime))
              : Math.floor((targetStats as unknown as { mtimeMs: number }).mtimeMs / 1000)
          }
          const mtimeOk =
            !state.options.preserveTimestamps || targetMtime === Math.floor(job.mtime ?? 0)
          const match = await this.verifyResumePrefix(
            state, job, job.target, plan.offset
          )
          if (match && plan.complete && mtimeOk) {
            const delta = job.size - job.transferred
            if (delta > 0) state.group.transferredBytes = Math.max(0, state.group.transferredBytes + delta)
            job.transferred = job.size
            await this.applyFileAttributes(state, job, upload, job.target)
            if (!upload) await this.removePartSidecar(job.target)
            return
          }
          if (match && !plan.complete && (await this.moveToPart(state, upload, job.target))) {
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
      job.sourceChanged = false
    }
    this.throwIfInterrupted(state)

    const remaining = job.size - offset
    if (
      !upload &&
      (job.parallel || (state.options.concurrency > 1 && remaining >= PARALLEL_MIN_BYTES))
    ) {
      await this.downloadParallel(state, job, partTarget, offset)
    } else {
      if (!upload) await this.writeSequentialSidecar(job, state)
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
    await this.completeJob(state, job, partTarget)
  }

  private async downloadOrUploadStream(
    state: GroupState,
    session: SftpSession,
    job: Job,
    partTarget: string,
    offset: number,
    upload: boolean
  ): Promise<void> {
    const endOffset = job.size > 0 ? job.size - 1 : undefined
    const reader: NodeJS.ReadableStream & { destroy: (err?: Error) => void } = upload
      ? createReadStream(job.source, {
          start: offset > 0 ? offset : undefined,
          end: endOffset
        })
      : session.createReadStream(job.source, {
          start: offset > 0 ? offset : undefined,
          end: endOffset,
          highWaterMark: PARALLEL_READ_HWM
        })
    let writer: NodeJS.WritableStream & { destroy: (err?: Error) => void }
    try {
      writer = upload
        ? session.createWriteStream(partTarget, offset > 0 ? 'a' : 'w')
        : createWriteStream(partTarget, {
            flags: offset > 0 ? 'a' : 'w',
            highWaterMark: PARALLEL_WRITE_HWM
          })
    } catch (err) {
      reader.destroy(err instanceof Error ? err : new Error(String(err)))
      throw err
    }

    let aborted = false
    const abort = (): void => {
      aborted = true
      reader.destroy(new Error('传输已中断'))
      writer.destroy(new Error('传输已中断'))
    }
    state.aborts.add(abort)
    try {
      this.throwIfInterrupted(state)
      await pipeline(reader as never, this.progress(state, job), writer as never)
    } catch (err) {
      throw aborted ? markAborted(err) : err
    } finally {
      state.aborts.delete(abort)
    }
  }

  private async downloadParallel(
    state: GroupState,
    job: Job,
    partTarget: string,
    offset: number
  ): Promise<void> {
    if (!job.parallel) {
      const parallel: ParallelState = {
        base: offset,
        mtime: Math.floor(job.mtime ?? 0),
        segments: planParallelSegments(job.size, offset, state.options.concurrency)
      }
      await this.writeSidecarAtomic(state, job.target, JSON.stringify(parallel))
      if (offset === 0) await fs.writeFile(partTarget, Buffer.alloc(0))
      job.parallel = parallel
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
        let reader: NodeJS.ReadableStream & { destroy: (err?: Error) => void } | undefined
        let writer: NodeJS.WritableStream & { destroy: (err?: Error) => void } | undefined
        try {
          reader = state.session.createReadStream(job.source, {
            start: from,
            end: segment.end - 1,
            highWaterMark: PARALLEL_READ_HWM
          })
          try {
            writer = createWriteStream(partTarget, {
              flags: 'r+',
              start: from,
              highWaterMark: PARALLEL_WRITE_HWM
            })
          } catch (err) {
            reader.destroy(err instanceof Error ? err : new Error(String(err)))
            throw err
          }
        } catch (err) {
          await this.persistParallelSidecar(job, state, partTarget)
          if (aborted || state.cancelled || state.paused) return
          failure = failure ?? (err instanceof Error ? err : new Error(String(err)))
          abortAll()
          return
        }
        const pair = { reader, writer }
        streams.add(pair)
        const writtenOf = (): number => (writer as unknown as { bytesWritten: number }).bytesWritten
        try {
          await pipeline(reader as never, this.progress(state, job), writer as never)
          if (writtenOf() !== length - segment.written) {
            throw new Error('分段大小校验失败')
          }
          segment.written = length
          await this.persistParallelSidecar(job, state, partTarget)
        } catch (err) {
          const persisted = Math.max(0, Math.min(length - segment.written, writtenOf()))
          segment.written += persisted
          await this.persistParallelSidecar(job, state, partTarget)
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
      const results = await Promise.allSettled(segments.map(() => worker()))
      for (const result of results) {
        if (result.status === 'rejected') {
          failure = failure ?? (result.reason instanceof Error ? result.reason : new Error(String(result.reason)))
        }
      }
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
    job: Job,
    upload: boolean,
    targetPath: string
  ): Promise<void> {
    const { preservePermissions, preserveTimestamps } = state.options
    try {
      if (preservePermissions && job.mode) {
        if (upload) await state.session.chmodEntry(targetPath, job.mode & PERMISSION_MASK)
        else await fs.chmod(targetPath, job.mode & PERMISSION_MASK)
      } else if (upload && !preservePermissions) {
        await state.session.chmodEntry(targetPath, 0o644)
      }
      if (preserveTimestamps && job.mtime !== undefined) {
        const atime = Math.floor(job.atime ?? job.mtime)
        const mtime = Math.floor(job.mtime)
        if (upload) await state.session.utimes(targetPath, atime, mtime)
        else await fs.utimes(targetPath, atime, mtime)
      }
    } catch {
      /* 属性设置失败不阻断传输 */
    }
  }

  private async applyDirAttributes(state: GroupState): Promise<void> {
    const { preservePermissions, preserveTimestamps } = state.options
    if (!preservePermissions && !preserveTimestamps) return
    const upload = state.group.direction === 'upload'
    const queue = [...state.dirs].sort((a, b) => b.path.length - a.path.length)
    const attrWorker = async (): Promise<void> => {
      for (;;) {
        const dir = queue.shift()
        if (!dir) return
        try {
          if (preservePermissions && dir.mode) {
            if (upload) await state.session.chmodEntry(dir.path, dir.mode & PERMISSION_MASK)
            else await fs.chmod(dir.path, dir.mode & PERMISSION_MASK)
          }
          if (preserveTimestamps && dir.mtime !== undefined) {
            const atime = Math.floor(dir.atime ?? dir.mtime)
            const mtime = Math.floor(dir.mtime)
            if (upload) await state.session.utimes(dir.path, atime, mtime)
            else await fs.utimes(dir.path, atime, mtime)
          }
        } catch {
          /* 属性设置失败不阻断传输 */
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WALK_CONCURRENCY, queue.length) }, () => attrWorker())
    )
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
