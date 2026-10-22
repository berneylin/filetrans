import { useEffect, useState, type DragEvent } from 'react'
import {
  ArrowLeft,
  Download,
  FolderOpen,
  FolderPlus,
  History,
  Home,
  Laptop,
  Lock,
  Pencil,
  RefreshCw,
  Server,
  ServerOff,
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
import { useUi } from '../stores/ui'
import { useVisits } from '../stores/visits'
import type { PaneSide } from '../types'
import { btn, btnSoft, iconBtn, input } from '../utils/styles'
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
    <div className="flex items-center gap-0.5 border-b border-ui-100 bg-ui-50/70 px-1.5 py-1">
      <button
        className={iconBtn}
        title="返回上一次的路径"
        disabled={!pane.canGoBack || pane.loading}
        onClick={() => void paneGoBack(side)}
      >
        <ArrowLeft size={13} />
      </button>
      <div className="relative">
        <button
          className={iconBtn}
          title="最近访问的路径"
          disabled={historyDisabled}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <History size={13} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onMouseDown={() => setMenuOpen(false)} />
            <div className="absolute top-full left-0 z-50 mt-1 w-96 animate-fade-in rounded-lg border border-ui-200 bg-ui-0 p-1 shadow-xl shadow-black/10">
              <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-ui-400">最近访问</div>
              {history.map((path) => (
                <button
                  key={path}
                  className={`block w-full truncate rounded-md px-2.5 py-1 text-left font-mono text-[11px] transition-colors hover:bg-blue-600 hover:text-white ${
                    path === pane.path ? 'text-ui-400' : 'text-ui-700'
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
              <div className="mx-1 my-1 h-px bg-ui-100" />
              <button
                className="block w-full rounded-md px-2.5 py-1 text-left text-ui-500 transition-colors hover:bg-ui-100 hover:text-ui-800"
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
      <div className="relative mx-0.5 min-w-0 flex-1">
        <FolderOpen
          size={13}
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ui-400"
        />
        <input
          className={`${input} w-full pl-7 font-mono text-[12px]`}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
      </div>
      <button
        className={iconBtn}
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
  const setSiteManagerOpen = useUi((state) => state.setSiteManagerOpen)
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
    if (event.dataTransfer.files.length > 0) {
      if (side === 'remote') {
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => window.api.getPathForFile(file))
          .filter(Boolean)
        transferPaths('local', paths)
      } else {
        window.alert('暂不支持把系统文件拖入本地面板，请拖到远程面板上传')
      }
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
      className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-ui-200 bg-ui-0 shadow-sm"
      onDragOver={(event) => {
        if (disabled) return
        const internal = event.dataTransfer.types.includes('application/x-filetrans')
        if (!internal && side === 'local') return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-ui-100 px-2.5">
        <div
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            isRemote
              ? pane.connected
                ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                : 'bg-ui-100 text-ui-400'
              : 'bg-ui-100 text-ui-600'
          }`}
        >
          {isRemote ? <Server size={13} /> : <Laptop size={13} />}
        </div>
        <span className="shrink-0 font-semibold text-ui-800">
          {isRemote ? '远程站点' : '本地站点'}
        </span>
        {isRemote && (
          <span className="truncate text-[12px] text-ui-500">
            {activeTab ? activeTab.title : '未打开标签页'}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            className={iconBtn}
            title="主目录"
            disabled={disabled}
            onClick={() => void goHome()}
          >
            <Home size={14} />
          </button>
          <button
            className={iconBtn}
            title="新建目录"
            disabled={disabled}
            onClick={() => promptMakeDirectory(side)}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className={iconBtn}
            title="重命名"
            disabled={disabled || selectedCount !== 1}
            onClick={() => startRename(side)}
          >
            <Pencil size={14} />
          </button>
          <button
            className={`${iconBtn} hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400`}
            title="删除"
            disabled={disabled || selectedCount === 0}
            onClick={() => void deleteSelection(side)}
          >
            <Trash2 size={14} />
          </button>
          <button
            className={iconBtn}
            title="权限"
            disabled={disabled || selectedCount === 0}
            onClick={() => promptChmod(side)}
          >
            <Lock size={14} />
          </button>
          <span className="mx-1 h-4 w-px bg-ui-200" />
          <button
            className={btnSoft}
            disabled={disabled || selectedCount === 0 || !canTransfer}
            onClick={() => transferSelection(side)}
          >
            {side === 'local' ? (
              <>
                <Upload size={13} />
                上传
              </>
            ) : (
              <>
                <Download size={13} />
                下载
              </>
            )}
          </button>
        </div>
      </div>
      <PathBar side={side} />
      {disabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div
            className={`mb-1 flex h-12 w-12 items-center justify-center rounded-full ${
              activeTab ? 'bg-red-50 dark:bg-red-500/10 text-red-400' : 'bg-ui-100 text-ui-400'
            }`}
          >
            {activeTab ? <ServerOff size={22} /> : <Server size={22} />}
          </div>
          {activeTab ? (
            <>
              <span className="font-medium text-red-600 dark:text-red-400">
                {activeTab.error ?? '未连接到远程服务器'}
              </span>
              {activeTab.error && (
                <span className="text-[12px] text-ui-400">可关闭该标签页后重新连接</span>
              )}
            </>
          ) : (
            <>
              <span className="font-medium text-ui-600">没有打开的标签页</span>
              <span className="text-[12px] text-ui-400">
                请从上方选择站点并点击连接，或使用“站点管理”
              </span>
              <button className={`${btn} mt-1`} onClick={() => setSiteManagerOpen(true)}>
                <Server size={13} className="text-ui-500" />
                打开站点管理
              </button>
            </>
          )}
        </div>
      ) : (
        <FileTable side={side} />
      )}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-ui-100 bg-ui-50/70 px-3 text-[11.5px] text-ui-500">
        <span>{pane.listing?.entries.length ?? 0} 个对象</span>
        {selectedCount > 0 && <span className="text-blue-600 dark:text-blue-400">已选择 {selectedCount} 个</span>}
        {pane.error && (
          <span className="truncate text-red-600 dark:text-red-400" title={pane.error}>
            {pane.error}
          </span>
        )}
      </div>
    </div>
  )
}
