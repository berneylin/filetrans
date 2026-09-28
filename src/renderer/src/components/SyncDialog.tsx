import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { findBannedDir } from '@shared/path'
import { errorMessage } from '../utils/errors'
import { btn, btnPrimary, dialogInput } from '../utils/styles'
import { paneRemoteSessionId, paneSelectedEntries, readPane } from '../pane'
import { useSettings } from '../stores/settings'
import { useSync } from '../stores/sync'
import { useTabs } from '../stores/tabs'
import { useUi } from '../stores/ui'
import { parseBannedDirs, pickSyncPath } from '../utils/sync'
import { Modal } from './Modal'

function rememberedPath(side: 'local' | 'remote'): string {
  const state = useSettings.getState()
  if (side === 'local') return state.syncLastLocal
  const siteId = useTabs.getState().activeTab()?.siteId
  return (siteId && state.syncLastRemote[siteId]) || ''
}

function prefillPane(side: 'local' | 'remote'): string {
  const dirs = paneSelectedEntries(side).filter((entry) => entry.type === 'directory')
  return pickSyncPath(readPane(side).path, dirs.map((entry) => entry.path), rememberedPath(side))
}

export function SyncDialog() {
  const open = useUi((state) => state.syncDialogOpen)
  const setOpen = useUi((state) => state.setSyncDialogOpen)
  const [direction, setDirection] = useState<'upload' | 'download'>('upload')
  const [localPath, setLocalPath] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [exclude, setExclude] = useState(useSettings.getState().syncExclude)
  const [deleteExtraneous, setDeleteExtraneous] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [initialized, setInitialized] = useState(false)

  if (open && !initialized) {
    setLocalPath(prefillPane('local'))
    setRemotePath(prefillPane('remote'))
    setDeleteExtraneous(false)
    setError(null)
    setBusy(false)
    setInitialized(true)
  }
  if (!open && initialized) {
    setInitialized(false)
  }

  if (!open) return null

  const browseLocal = async (): Promise<void> => {
    const picked = await window.api.pickDirectory({ title: '选择本地目录' })
    if (picked) setLocalPath(picked)
  }

  const usePaneRemote = (): void => {
    setRemotePath(prefillPane('remote'))
  }

  const start = async (): Promise<void> => {
    if (!localPath.trim() || !remotePath.trim()) {
      setError('请填写本地目录与远程目录')
      return
    }
    const sessionId = paneRemoteSessionId()
    if (!sessionId) {
      setError('请先连接远程服务器')
      return
    }
    const siteId = useTabs.getState().activeTab()?.siteId
    const bannedDirs = parseBannedDirs(useSettings.getState().syncBannedPaths)
    if (bannedDirs.length > 0) {
      const localBanned = findBannedDir(localPath, bannedDirs)
      if (localBanned) {
        setError(`本地目录已被禁用同步: ${localBanned}`)
        return
      }
      const remoteBanned = findBannedDir(remotePath, bannedDirs)
      if (remoteBanned) {
        setError(`远程目录已被禁用同步: ${remoteBanned}`)
        return
      }
    }
    if (deleteExtraneous) {
      const target = direction === 'upload' ? remotePath : localPath
      const ok = window.confirm(
        `开启“删除目标端多余文件”后，目标目录 ${target} 中源端不存在的文件将被删除。\n确定继续吗？`
      )
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      useSettings.getState().update({ syncExclude: exclude })
      const local = localPath.trim()
      const remote = remotePath.trim()
      const id = await window.api.sync.start({
        sessionId,
        direction,
        localPath: local,
        remotePath: remote,
        bannedDirs,
        options: {
          deleteExtraneous,
          exclude: exclude
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          compress: useSettings.getState().syncCompress
        }
      })
      useSync
        .getState()
        .onSuccess(id, () => useSettings.getState().rememberSyncPaths(local, remote, siteId))
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="目录同步 (rsync)" onClose={() => setOpen(false)} width={560}>
      <div className="space-y-2">
        <label className="flex items-center gap-4">
          <span className="w-14 text-gray-600">方向</span>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="radio"
              checked={direction === 'upload'}
              onChange={() => setDirection('upload')}
            />
            <ArrowUp size={13} className="text-blue-500" />
            本地 → 远程
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="radio"
              checked={direction === 'download'}
              onChange={() => setDirection('download')}
            />
            <ArrowDown size={13} className="text-green-600" />
            远程 → 本地
          </label>
        </label>
        <label className="grid grid-cols-[70px_1fr_64px] items-center gap-2">
          <span className="text-right text-gray-600">本地目录</span>
          <input
            className={dialogInput}
            value={localPath}
            onChange={(event) => setLocalPath(event.target.value)}
          />
          <button className={btn} onClick={() => void browseLocal()}>
            浏览…
          </button>
        </label>
        <label className="grid grid-cols-[70px_1fr_64px] items-center gap-2">
          <span className="text-right text-gray-600">远程目录</span>
          <input
            className={dialogInput}
            value={remotePath}
            onChange={(event) => setRemotePath(event.target.value)}
          />
          <button className={btn} onClick={usePaneRemote}>
            取面板
          </button>
        </label>
        <div className="text-[11px] text-gray-400">
          源目录内容将镜像到目标目录（等价 rsync src/ dst/），未变化的文件自动跳过。
        </div>
        <label className="grid grid-cols-[70px_1fr] items-start gap-2">
          <span className="pt-1 text-right text-gray-600">排除规则</span>
          <textarea
            className={`${dialogInput} h-16 resize-none font-mono`}
            value={exclude}
            onChange={(event) => setExclude(event.target.value)}
            placeholder="每行一条 rsync 排除模式，如 .venv*"
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={deleteExtraneous}
            onChange={(event) => setDeleteExtraneous(event.target.checked)}
          />
          <span className="text-gray-700">
            删除目标端多余文件（rsync --delete）
            {deleteExtraneous && (
              <span className="block text-red-600">
                警告：目标端源端不存在的文件将被删除，请谨慎开启！
              </span>
            )}
          </span>
        </label>
        {error && <div className="text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className={btn} onClick={() => setOpen(false)}>
            取消
          </button>
          <button className={btnPrimary} disabled={busy} onClick={() => void start()}>
            {busy ? '启动中…' : '开始同步'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
