import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Eraser,
  File,
  Inbox,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Settings,
  SkipForward,
  X
} from 'lucide-react'
import { formatEta, formatSize, formatSpeed } from '@shared/format'
import type {
  SyncJob,
  SyncStatus,
  TransferFileProgress,
  TransferGroup,
  TransferStatus
} from '@shared/types'
import { useSync } from '../stores/sync'
import { useTransfers } from '../stores/transfers'
import { btn, iconBtnSm } from '../utils/styles'
import { TransferSettingsDialog } from './TransferSettingsDialog'

const STATUS_TEXT: Record<TransferStatus, string> = {
  pending: '等待中',
  active: '传输中',
  paused: '已暂停',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
}

const STATUS_CLASS: Record<TransferStatus, string> = {
  pending: 'bg-ui-100 text-ui-600',
  active: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300',
  paused: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
  done: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
  cancelled: 'bg-ui-100 text-ui-500'
}

const DEFAULT_QUEUE_HEIGHT = 280
const MIN_QUEUE_HEIGHT = 120
const MAX_QUEUE_HEIGHT = 1200
const HEIGHT_STORAGE_KEY = 'filetrans-queue-height'

function clampQueueHeight(height: number): number {
  return Math.min(Math.max(height, MIN_QUEUE_HEIGHT), MAX_QUEUE_HEIGHT)
}

function statusText(group: TransferGroup): string {
  if (group.status === 'active' && group.retryCount) {
    return `重试 ${group.retryCount}`
  }
  if (group.status === 'error' && group.failedCount) {
    return `失败 ${group.failedCount}`
  }
  if (group.status === 'pending' && group.collecting) {
    return '展开目录中'
  }
  return STATUS_TEXT[group.status]
}

function StatusBadge({ className, text }: { className: string; text: string }) {
  return (
    <span className="w-16 shrink-0">
      <span
        className={`inline-block max-w-full truncate rounded-full px-2 py-px text-[11px] font-medium ${className}`}
        title={text}
      >
        {text}
      </span>
    </span>
  )
}

function DirectionIcon({ direction }: { direction: 'upload' | 'download' }) {
  return direction === 'upload' ? (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
      <ArrowUp size={13} />
    </span>
  ) : (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
      <ArrowDown size={13} />
    </span>
  )
}

function ProgressBar({ group }: { group: TransferGroup }) {
  const percent =
    group.totalBytes > 0
      ? Math.min(100, Math.round((group.transferredBytes / group.totalBytes) * 100))
      : group.totalFiles > 0
        ? Math.round((group.doneFiles / group.totalFiles) * 100)
        : 0
  const barClass =
    group.status === 'error'
      ? 'bg-red-400'
      : group.status === 'paused'
        ? 'bg-amber-400'
        : group.status === 'done'
          ? 'bg-emerald-500'
          : 'bg-gradient-to-r from-blue-500 to-indigo-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-ui-100">
        <div
          className={`h-full rounded-full transition-all ${barClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-10 text-right text-[12px] font-medium tabular-nums text-ui-700">
        {percent}%
      </span>
    </div>
  )
}

function FileRow({ file }: { file: TransferFileProgress }) {
  const percent =
    file.size > 0 ? Math.min(100, Math.round((file.transferred / file.size) * 100)) : 0
  return (
    <div className="flex items-center gap-2 py-0.5 pr-3 pl-11 text-[11px] text-ui-600">
      <File size={12} className="shrink-0 text-ui-400" />
      <span className="min-w-24 flex-1 truncate" title={file.path}>
        {file.name}
      </span>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-ui-100">
        <div
          className="h-full rounded-full bg-blue-400 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-8 text-right tabular-nums">{percent}%</span>
      <span className="w-28 text-right tabular-nums">
        {formatSize(file.transferred)} / {formatSize(file.size)}
      </span>
      <span className="w-16 text-right tabular-nums">{formatSpeed(file.speed)}</span>
      <span className="w-24 text-right tabular-nums text-ui-400">
        {formatEta(file.size - file.transferred, file.speed)}
      </span>
    </div>
  )
}

const SYNC_STATUS_TEXT: Record<SyncStatus, string> = {
  running: '运行中',
  done: '已完成',
  error: '失败',
  cancelled: '已取消'
}

const SYNC_STATUS_CLASS: Record<SyncStatus, string> = {
  running: 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300',
  done: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
  cancelled: 'bg-ui-100 text-ui-500'
}

function SyncRow({ job }: { job: SyncJob }) {
  const cancel = useSync((state) => state.cancel)
  const [logOpen, setLogOpen] = useState(false)
  const [logText, setLogText] = useState('')
  const [logLoading, setLogLoading] = useState(false)

  const ratio = Math.min(1, job.percent / 100)
  const totalBytes = job.percent > 0 ? job.transferredBytes / ratio : 0
  const eta =
    job.status === 'running' ? formatEta(totalBytes - job.transferredBytes, job.speed) : ''

  const toggleLog = async (): Promise<void> => {
    if (logOpen) {
      setLogOpen(false)
      return
    }
    setLogOpen(true)
    setLogLoading(true)
    try {
      setLogText((await window.api.sync.getLog(job.id)) || '（暂无日志）')
    } catch {
      setLogText('无法获取日志')
    } finally {
      setLogLoading(false)
    }
  }

  return (
    <div className="border-b border-ui-100 transition-colors last:border-b-0 hover:bg-ui-50/60">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <DirectionIcon direction={job.direction} />
        <span className="w-64 truncate text-ui-800" title={job.localPath}>
          {job.localPath}
        </span>
        <RefreshCw size={11} className="shrink-0 text-ui-300" />
        <span className="w-64 truncate text-ui-500" title={job.remotePath}>
          {job.remotePath}
        </span>
        <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-ui-100">
          <div
            className={`h-full rounded-full transition-all ${
              job.status === 'error'
                ? 'bg-red-400'
                : job.status === 'done'
                  ? 'bg-emerald-500'
                  : 'bg-gradient-to-r from-blue-500 to-indigo-500'
            }`}
            style={{ width: `${Math.min(100, job.percent)}%` }}
          />
        </div>
        <span className="w-10 text-right text-[12px] font-medium tabular-nums text-ui-700">
          {Math.min(100, job.percent)}%
        </span>
        <span className="w-16 text-right text-ui-500 tabular-nums">{formatSpeed(job.speed)}</span>
        <span className="w-24 text-right text-ui-500 tabular-nums">{eta}</span>
        <span
          className="w-14 text-right text-ui-500 tabular-nums"
          title={`${job.transferredFiles} 个文件`}
        >
          {job.transferredFiles} 个
        </span>
        <StatusBadge className={SYNC_STATUS_CLASS[job.status]} text={SYNC_STATUS_TEXT[job.status]} />
        <button
          className={`${iconBtnSm} hover:text-red-600 dark:hover:text-red-400`}
          disabled={job.status !== 'running'}
          title="取消"
          onClick={() => void cancel(job.id)}
        >
          <X size={13} />
        </button>
        <button
          className={`${iconBtnSm} ${logOpen ? 'bg-ui-100 text-blue-600 dark:text-blue-400' : 'hover:text-blue-600 dark:hover:text-blue-400'}`}
          title="日志"
          onClick={() => void toggleLog()}
        >
          <ScrollText size={13} />
        </button>
      </div>
      {job.currentFile && job.status === 'running' && (
        <div
          className="truncate pr-3 pb-1.5 pl-11 text-[11px] text-ui-500"
          title={job.currentFile}
        >
          {job.currentFile}
        </div>
      )}
      {job.error && (
        <div className="truncate pr-3 pb-1.5 pl-11 text-[11px] text-red-600 dark:text-red-400" title={job.error}>
          {job.error}
        </div>
      )}
      {logOpen && (
        <pre className="mx-3 mb-2 ml-11 max-h-40 overflow-auto rounded-md border border-ui-200 bg-ui-50 p-2 font-mono text-[10px] leading-4 text-ui-600 select-text">
          {logLoading ? '加载中…' : logText || '（暂无输出）'}
        </pre>
      )}
    </div>
  )
}

interface GroupRowProps {
  group: TransferGroup
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}

const TransferGroupRow = memo(function TransferGroupRow({
  group,
  onPause,
  onResume,
  onCancel
}: GroupRowProps) {
  return (
    <div className="border-b border-ui-100 transition-colors last:border-b-0 hover:bg-ui-50/60">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <DirectionIcon direction={group.direction} />
        <span className="w-40 truncate font-medium text-ui-800" title={group.sourceLabel}>
          {group.sourceLabel}
        </span>
        <ArrowRight size={12} className="shrink-0 text-ui-300" />
        <span className="w-48 truncate text-ui-500" title={group.targetDir}>
          {group.targetDir}
        </span>
        <div className="min-w-40 flex-1">
          <ProgressBar group={group} />
        </div>
        <span className="w-16 text-right text-ui-500 tabular-nums">
          {formatSize(group.totalBytes)}
        </span>
        <span className="w-16 text-right text-ui-500 tabular-nums">
          {formatSpeed(group.speed)}
        </span>
        <span className="w-24 text-right text-ui-500 tabular-nums">
          {group.status === 'active'
            ? formatEta(group.totalBytes - group.transferredBytes, group.speed)
            : ''}
        </span>
        <span className="w-14 text-right text-ui-500 tabular-nums">
          {group.doneFiles}/{group.totalFiles}
        </span>
        <StatusBadge className={STATUS_CLASS[group.status]} text={statusText(group)} />
        <button
          className={`${iconBtnSm} hover:text-amber-600 dark:hover:text-amber-400`}
          disabled={group.status !== 'active'}
          title="暂停"
          onClick={() => onPause(group.id)}
        >
          <Pause size={13} />
        </button>
        <button
          className={`${iconBtnSm} hover:text-emerald-600 dark:hover:text-emerald-400`}
          disabled={group.status !== 'paused'}
          title="继续"
          onClick={() => onResume(group.id)}
        >
          <Play size={13} />
        </button>
        <button
          className={`${iconBtnSm} hover:text-red-600 dark:hover:text-red-400`}
          disabled={
            group.status !== 'active' &&
            group.status !== 'pending' &&
            group.status !== 'paused'
          }
          title="取消"
          onClick={() => onCancel(group.id)}
        >
          <X size={13} />
        </button>
        {group.error && (
          <span className="max-w-60 truncate text-[12px] text-red-600 dark:text-red-400" title={group.error}>
            {group.error}
          </span>
        )}
        {!group.error && group.warning && (
          <span className="max-w-60 truncate text-[12px] text-amber-600 dark:text-amber-400" title={group.warning}>
            {group.warning}
          </span>
        )}
      </div>
      {group.activeFiles && group.activeFiles.length > 0 && (
        <div className="pb-1.5">
          {group.activeFiles.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
        </div>
      )}
      {group.failedFiles && group.failedFiles.length > 0 && (
        <div className="pb-1.5">
          {group.failedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 py-0.5 pr-3 pl-11 text-[11px] text-red-600 dark:text-red-400"
            >
              <X size={12} className="shrink-0" />
              <span className="min-w-24 flex-1 truncate" title={file.path}>
                {file.name}
              </span>
              <span className="min-w-24 max-w-1/2 truncate" title={file.error}>
                {file.error}
              </span>
            </div>
          ))}
        </div>
      )}
      {group.skippedFiles && group.skippedFiles.length > 0 && (
        <div className="pb-1.5">
          {group.skippedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 py-0.5 pr-3 pl-11 text-[11px] text-amber-600 dark:text-amber-400"
            >
              <SkipForward size={12} className="shrink-0" />
              <span className="min-w-24 flex-1 truncate" title={file.path}>
                {file.name}
              </span>
              <span className="min-w-24 max-w-1/2 truncate" title={file.error}>
                {file.error}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export function TransferPanel() {
  const groups = useTransfers((state) => state.groups)
  const error = useTransfers((state) => state.error)
  const cancel = useTransfers((state) => state.cancel)
  const pause = useTransfers((state) => state.pause)
  const resume = useTransfers((state) => state.resume)
  const clearFinished = useTransfers((state) => state.clearFinished)
  const syncJobs = useSync((state) => state.jobs)
  const clearSyncFinished = useSync((state) => state.clearFinished)
  const setError = useTransfers((state) => state.setError)
  const onPauseGroup = useCallback((id: string) => void pause(id), [pause])
  const onResumeGroup = useCallback((id: string) => void resume(id), [resume])
  const onCancelGroup = useCallback((id: string) => void cancel(id), [cancel])
  const [open, setOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [height, setHeight] = useState(() => {
    const stored = Number(localStorage.getItem(HEIGHT_STORAGE_KEY))
    return clampQueueHeight(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_QUEUE_HEIGHT)
  })
  const heightRef = useRef(height)
  heightRef.current = height
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      setHeight(clampQueueHeight(drag.startHeight + (drag.startY - event.clientY)))
    }
    const onUp = (): void => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(heightRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  const activeCount =
    groups.filter((group) => group.status === 'active' || group.status === 'pending').length +
    syncJobs.filter((job) => job.status === 'running').length

  return (
    <div className="flex shrink-0 flex-col" style={open ? { height, maxHeight: '75vh' } : undefined}>
      <div
        className="group flex h-2 shrink-0 cursor-row-resize items-center px-3"
        title="拖动调整传输队列高度"
        onMouseDown={(event) => {
          if (!open) setOpen(true)
          const panel = event.currentTarget.parentElement
          dragRef.current = {
            startY: event.clientY,
            startHeight: panel ? panel.getBoundingClientRect().height : heightRef.current
          }
          document.body.style.cursor = 'row-resize'
          document.body.style.userSelect = 'none'
        }}
      >
        <div className="h-0.5 w-full rounded-full transition-colors group-hover:bg-blue-400" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ui-200 bg-ui-0 shadow-sm">
        <div
          className={`flex h-9 shrink-0 items-center gap-2 px-3 ${
            open ? 'border-b border-ui-100' : ''
          }`}
        >
          <button
            className="flex items-center gap-1.5 text-ui-700 transition-colors hover:text-blue-700 dark:hover:text-blue-300"
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            <span className="font-semibold">传输队列</span>
            {activeCount > 0 && (
              <span className="rounded-full bg-blue-600 px-1.5 py-px text-[11px] font-medium text-white">
                {activeCount} 进行中
              </span>
            )}
          </button>
          {error && (
            <span className="truncate text-[12px] text-red-600 dark:text-red-400" title={error}>
              {error}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {error && (
              <button className={btn} onClick={() => setError(null)}>
                清除提示
              </button>
            )}
            <button className={btn} title="传输设置" onClick={() => setSettingsOpen(true)}>
              <Settings size={13} className="text-ui-500" />
              设置
            </button>
            <button
              className={btn}
              disabled={groups.length === 0 && syncJobs.length === 0}
              onClick={() => {
                void clearFinished()
                void clearSyncFinished()
              }}
            >
              <Eraser size={13} className="text-ui-500" />
              清除已完成
            </button>
          </div>
        </div>
        {open && (
          <div className="min-h-0 flex-1 overflow-auto">
            {groups.length === 0 && syncJobs.length === 0 ? (
              <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1.5 text-ui-400">
                <Inbox size={24} strokeWidth={1.5} className="text-ui-300" />
                <span>暂无传输任务</span>
              </div>
            ) : (
              <>
                {groups.map((group) => (
                  <TransferGroupRow
                    key={group.id}
                    group={group}
                    onPause={onPauseGroup}
                    onResume={onResumeGroup}
                    onCancel={onCancelGroup}
                  />
                ))}
                {syncJobs.length > 0 && (
                  <div className="border-y border-ui-100 bg-ui-50 px-3 py-1 text-[11px] font-medium text-ui-500">
                    同步任务 (rsync)
                  </div>
                )}
                {syncJobs.map((job) => (
                  <SyncRow key={job.id} job={job} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {settingsOpen && <TransferSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
