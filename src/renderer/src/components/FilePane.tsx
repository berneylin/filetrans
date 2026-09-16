import { useEffect, useState, type DragEvent } from 'react'
import {
  ArrowLeft,
  Download,
  FolderPlus,
  History,
  Home,
  Lock,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import {
  deleteSelection,
  promptChmod,
  promptMakeDirectory,
  startRename,
  transferPaths,
  transferSelection
} from '../actions'
import { paneGoBack, paneNavigate, paneRefresh, paneRemoteSessionId, usePane } from '../pane'
import { useTabs } from '../stores/tabs'
import { useVisits } from '../stores/visits'
import type { PaneSide } from '../types'
import { btn, input } from '../utils/styles'
import { FileTable } from './FileTable'

function PathBar({ side }: { side: PaneSide }) {
  const pane = usePane(side)
  const siteId = useTabs((state) => state.tabs.find((item) => item.id === state.activeId)?.siteId)
  const localHistory = useVisits((state) => state.local)
  const remoteHistory = useVisits((state) => (siteId ? state.remote[siteId] : undefined))
  const clearLocal = useVisits((state) => state.clearLocal)
  const clearRemote = useVisits((state) => state.clearRemote)
  const [value, setValue] = useState(pane.path)
  const [menuOpen, setMenuOpen] = useState(false)

  const history = side === 'local' ? localHistory : (remoteHistory ?? [])
  const historyDisabled = history.length === 0 || (side === 'remote' && !pane.connected)

  useEffect(() => {
    setValue(pane.path)
  }, [pane.path])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  const submit = (): void => {
    const target = value.trim()
    if (target) void paneNavigate(side, target)
  }

  return (
    <div className="flex items-center gap-1 border-b border-gray-200 bg-white px-1 py-1">
      <button
        className={btn}
        title="返回上一次的路径"
        disabled={!pane.canGoBack || pane.loading}
        onClick={() => void paneGoBack(side)}
      >
        <ArrowLeft size={13} />
      </button>
      <div className="relative">
        <button
          className={btn}
          title="最近访问的路径"
          disabled={historyDisabled}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <History size={13} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setMenuOpen(false)} />
            <div className="absolute left-0 top-full z-50 mt-1 w-96 rounded border border-gray-300 bg-white py-1 shadow-lg">
              {history.map((path) => (
                <button
                  key={path}
                  className={`block w-full truncate px-3 py-1 text-left font-mono text-[11px] hover:bg-blue-600 hover:text-white ${
                    path === pane.path ? 'text-gray-400' : ''
                  }`}
                  title={path}
                  onClick={() => {
                    setMenuOpen(false)
                    if (path !== pane.path) void paneNavigate(side, path)
                  }}
                >
                  {path}
                </button>
              ))}
              <div className="my-1 border-t border-gray-200" />
              <button
                className="block w-full px-3 py-1 text-left text-gray-500 hover:bg-blue-600 hover:text-white"
                onClick={() => {
                  setMenuOpen(false)
                  if (side === 'local') clearLocal()
                  else if (siteId) clearRemote(siteId)
                }}
              >
                清除历史
              </button>
            </div>
          </>
        )}
      </div>
      <input
        className={`${input} min-w-0 flex-1 font-mono`}
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit()
        }}
      />
      <button
        className={btn}
        title="刷新 (F5 同时刷新两侧)"
        disabled={pane.loading}
        onClick={() => void paneRefresh(side)}
      >
        <RefreshCw size={13} className={pane.loading ? 'animate-spin' : ''} />
      </button>
    </div>
  )
}

export function FilePane({ side }: { side: PaneSide }) {
  const pane = usePane(side)
  const activeTab = useTabs((state) => state.tabs.find((tab) => tab.id === state.activeId) ?? null)
  const isRemote = side === 'remote'
  const disabled = isRemote && !pane.connected
  const selectedCount = pane.selected.length
  const canTransfer = side === 'local' ? paneRemoteSessionId() !== null : true

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    if (disabled) return
    const raw = event.dataTransfer.getData('application/x-filetrans')
    if (raw) {
      try {
        const data = JSON.parse(raw) as { side: PaneSide; paths: string[] }
        if (data.side !== side) transferPaths(data.side, data.paths)
      } catch {
        /* 忽略无效拖拽数据 */
      }
      return
    }
    if (side === 'remote' && event.dataTransfer.files.length > 0) {
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => window.api.getPathForFile(file))
        .filter(Boolean)
      transferPaths('local', paths)
    }
  }

  const goHome = async (): Promise<void> => {
    let home = ''
    if (isRemote) {
      const sessionId = paneRemoteSessionId()
      if (sessionId) home = await window.api.sftp.home(sessionId).catch(() => '')
    } else {
      home = await window.api.local.home()
    }
    if (home) await paneNavigate(side, home)
  }

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (disabled) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1 border-b border-gray-300 bg-gray-100 px-2 py-1">
        <span className="font-semibold text-gray-700">{isRemote ? '远程站点' : '本地站点'}</span>
        {isRemote && (
          <span className="truncate text-gray-500">
            {activeTab ? activeTab.title : '未打开标签页'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            className={btn}
            title="主目录"
            disabled={disabled}
            onClick={() => void goHome()}
          >
            <Home size={13} />
          </button>
          <button
            className={btn}
            title="新建目录"
            disabled={disabled}
            onClick={() => promptMakeDirectory(side)}
          >
            <FolderPlus size={13} />
          </button>
          <button
            className={btn}
            title="重命名"
            disabled={disabled || selectedCount !== 1}
            onClick={() => startRename(side)}
          >
            <Pencil size={13} />
          </button>
          <button
            className={btn}
            title="删除"
            disabled={disabled || selectedCount === 0}
            onClick={() => void deleteSelection(side)}
          >
            <Trash2 size={13} />
          </button>
          <button
            className={btn}
            title="权限"
            disabled={disabled || selectedCount === 0}
            onClick={() => promptChmod(side)}
          >
            <Lock size={13} />
          </button>
          <button
            className={btn}
            disabled={disabled || selectedCount === 0 || !canTransfer}
            onClick={() => transferSelection(side)}
          >
            {side === 'local' ? (
              <>
                <Upload size={13} className="mr-1 inline" />
                上传
              </>
            ) : (
              <>
                <Download size={13} className="mr-1 inline" />
                下载
              </>
            )}
          </button>
        </div>
      </div>
      <PathBar side={side} />
      {disabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-white text-gray-400">
          {activeTab ? (
            <>
              <span className="text-red-600">{activeTab.error ?? '未连接到远程服务器'}</span>
              {activeTab.error && <span>可关闭该标签页后重新连接</span>}
            </>
          ) : (
            <>
              <span>没有打开的标签页</span>
              <span>请从上方选择站点并点击连接，或使用“站点管理”</span>
            </>
          )}
        </div>
      ) : (
        <FileTable side={side} />
      )}
      <div className="flex items-center gap-3 border-t border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-500">
        <span>{pane.listing?.entries.length ?? 0} 个对象</span>
        {selectedCount > 0 && <span>已选择 {selectedCount} 个</span>}
        {pane.error && (
          <span className="truncate text-red-600" title={pane.error}>
            {pane.error}
          </span>
        )}
      </div>
    </div>
  )
}
