import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  File,
  Pause,
  Play,
  RefreshCw,
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
import { btn } from '../utils/styles'
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
  pending: 'text-gray-500',
  active: 'text-blue-600',
  paused: 'text-amber-600',
  done: 'text-green-600',
  error: 'text-red-600',
  cancelled: 'text-amber-600'
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
          ? 'bg-green-500'
          : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-3 min-w-24 flex-1 overflow-hidden rounded border border-gray-300 bg-gray-100">
        <div className={`h-full transition-all ${barClass}`} style={{ width: `${percent}%` }} />
      </div>
      <span className="w-10 text-right tabular-nums">{percent}%</span>
    </div>
  )
}

function FileRow({ file }: { file: TransferFileProgress }) {
  const percent =
    file.size > 0 ? Math.min(100, Math.round((file.transferred / file.size) * 100)) : 0
  return (
    <div className="flex items-center gap-2 px-2 py-0.5 pl-7 text-[11px] text-gray-600">
      <File size={12} className="shrink-0 text-gray-400" />
      <span className="min-w-24 flex-1 truncate" title={file.path}>
        {file.name}
      </span>
      <div className="h-2 w-32 overflow-hidden rounded border border-gray-300 bg-gray-100">
        <div className="h-full bg-blue-400 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums">{percent}%</span>
      <span className="w-28 text-right tabular-nums">
        {formatSize(file.transferred)} / {formatSize(file.size)}
      </span>
      <span className="w-16 text-right tabular-nums">{formatSpeed(file.speed)}</span>
      <span className="w-24 text-right tabular-nums text-gray-400">
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
  running: 'text-blue-600',
  done: 'text-green-600',
  error: 'text-red-600',
  cancelled: 'text-amber-600'
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
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-1">
        {job.direction === 'upload' ? (
          <ArrowUp size={13} className="shrink-0 text-blue-500" />
        ) : (
          <ArrowDown size={13} className="shrink-0 text-green-600" />
        )}
        <span className="w-64 truncate" title={job.localPath}>
          {job.localPath}
        </span>
        <RefreshCw size={11} className="shrink-0 text-gray-400" />
        <span className="w-64 truncate text-gray-500" title={job.remotePath}>
          {job.remotePath}
        </span>
        <div className="h-3 min-w-24 flex-1 overflow-hidden rounded border border-gray-300 bg-gray-100">
          <div
            className={`h-full transition-all ${
              job.status === 'error' ? 'bg-red-400' : 'bg-blue-500'
            }`}
            style={{ width: `${Math.min(100, job.percent)}%` }}
          />
        </div>
        <span className="w-10 text-right tabular-nums">{Math.min(100, job.percent)}%</span>
        <span className="w-16 text-right text-gray-500">{formatSpeed(job.speed)}</span>
        <span className="w-24 text-right text-gray-500">{eta}</span>
        <span className="w-14 text-right text-gray-500" title={`${job.transferredFiles} 个文件`}>
          {job.transferredFiles} 个
        </span>
        <span className={`w-14 ${SYNC_STATUS_CLASS[job.status]}`}>
          {SYNC_STATUS_TEXT[job.status]}
        </span>
        <button
          className="shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-30"
          disabled={job.status !== 'running'}
          title="取消"
          onClick={() => void cancel(job.id)}
        >
          <X size={13} />
        </button>
        <button
          className="shrink-0 text-[11px] text-gray-400 hover:text-blue-600"
          onClick={() => void toggleLog()}
        >
          日志
        </button>
      </div>
      {job.currentFile && job.status === 'running' && (
        <div className="truncate px-2 pb-1 pl-7 text-[11px] text-gray-500" title={job.currentFile}>
          {job.currentFile}
        </div>
      )}
      {job.error && (
        <div className="truncate px-2 pb-1 pl-7 text-[11px] text-red-600" title={job.error}>
          {job.error}
        </div>
      )}
      {logOpen && (
        <pre className="mx-2 mb-1 max-h-40 overflow-auto rounded bg-gray-50 p-1.5 font-mono text-[10px] leading-4 text-gray-600">
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
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-2 px-2 py-1">
        {group.direction === 'upload' ? (
          <ArrowUp size={13} className="shrink-0 text-blue-500" />
        ) : (
          <ArrowDown size={13} className="shrink-0 text-green-600" />
        )}
        <span className="w-40 truncate" title={group.sourceLabel}>
          {group.sourceLabel}
        </span>
        <span className="text-gray-400">→</span>
        <span className="w-48 truncate text-gray-500" title={group.targetDir}>
          {group.targetDir}
        </span>
        <div className="min-w-40 flex-1">
          <ProgressBar group={group} />
        </div>
        <span className="w-16 text-right text-gray-500">{formatSize(group.totalBytes)}</span>
        <span className="w-16 text-right text-gray-500">{formatSpeed(group.speed)}</span>
        <span className="w-24 text-right text-gray-500">
          {group.status === 'active'
            ? formatEta(group.totalBytes - group.transferredBytes, group.speed)
            : ''}
        </span>
        <span className="w-14 text-right text-gray-500">
          {group.doneFiles}/{group.totalFiles}
        </span>
        <span className={`w-16 ${STATUS_CLASS[group.status]}`}>{statusText(group)}</span>
        <button
          className="shrink-0 text-gray-400 hover:text-amber-600 disabled:opacity-30"
          disabled={group.status !== 'active'}
          title="暂停"
          onClick={() => onPause(group.id)}
        >
          <Pause size={13} />
        </button>
        <button
          className="shrink-0 text-gray-400 hover:text-green-600 disabled:opacity-30"
          disabled={group.status !== 'paused'}
          title="继续"
          onClick={() => onResume(group.id)}
        >
          <Play size={13} />
        </button>
        <button
          className="shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-30"
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
          <span className="max-w-60 truncate text-red-600" title={group.error}>
            {group.error}
          </span>
        )}
        {!group.error && group.warning && (
          <span className="max-w-60 truncate text-amber-600" title={group.warning}>
            {group.warning}
          </span>
        )}
      </div>
      {group.activeFiles && group.activeFiles.length > 0 && (
        <div className="pb-1">
          {group.activeFiles.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
        </div>
      )}
      {group.failedFiles && group.failedFiles.length > 0 && (
        <div className="pb-1">
          {group.failedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 px-2 py-0.5 pl-7 text-[11px] text-red-600"
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
        <div className="pb-1">
          {group.skippedFiles.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 px-2 py-0.5 pl-7 text-[11px] text-amber-600"
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
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(heightRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const activeCount =
    groups.filter((group) => group.status === 'active' || group.status === 'pending').length +
    syncJobs.filter((job) => job.status === 'running').length

  return (
    <div
      className="flex flex-col border-t border-gray-300 bg-white"
      style={open ? { height, maxHeight: '75vh' } : undefined}
    >
      <div
        className="h-1.5 shrink-0 cursor-row-resize bg-gray-200 hover:bg-blue-400"
        title="拖动调整传输队列高度"
        onMouseDown={(event) => {
          if (!open) setOpen(true)
          const panel = event.currentTarget.parentElement
          dragRef.current = {
            startY: event.clientY,
            startHeight: panel ? panel.getBoundingClientRect().height : heightRef.current
          }
          document.body.style.cursor = 'row-resize'
        }}
      />
      <div className="flex shrink-0 items-center gap-2 bg-gray-100 px-2 py-0.5">
        <button
          className="flex items-center gap-1 text-gray-700 hover:text-blue-700"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="font-semibold">传输队列</span>
          {activeCount > 0 && <span className="text-blue-600">({activeCount} 进行中)</span>}
        </button>
        {error && (
          <span className="truncate text-red-600" title={error}>
            {error}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {error && (
            <button className={btn} onClick={() => setError(null)}>
              清除提示
            </button>
          )}
          <button
            className={btn}
            title="传输设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={13} className="mr-1 inline" />
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
            清除已完成
          </button>
        </div>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto">
          {groups.length === 0 && syncJobs.length === 0 ? (
            <div className="px-2 py-2 text-center text-gray-400">暂无传输任务</div>
          ) : (
            <>
              {groups.map((group) => (
                <TransferGroupRow
                  key={group.id}
                  group={group}
                  onPause={(id) => void pause(id)}
                  onResume={(id) => void resume(id)}
                  onCancel={(id) => void cancel(id)}
                />
              ))}
              {syncJobs.length > 0 && (
                <div className="border-b border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold text-gray-500">
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
      {settingsOpen && <TransferSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
