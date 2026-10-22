import { useEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { ChmodDialog } from './components/ChmodDialog'
import { ConflictDialog } from './components/ConflictDialog'
import { ContextMenu } from './components/ContextMenu'
import { FilePane } from './components/FilePane'
import { HostKeyDialog } from './components/HostKeyDialog'
import { PromptDialog } from './components/PromptDialog'
import { SiteManagerDialog } from './components/SiteManagerDialog'
import { StatusBar } from './components/StatusBar'
import { SyncDialog } from './components/SyncDialog'
import { TabBar } from './components/TabBar'
import { Toolbar } from './components/Toolbar'
import { TransferPanel } from './components/TransferPanel'
import { useFiles } from './stores/files'
import { useSites } from './stores/sites'
import { useSync } from './stores/sync'
import { useTabs } from './stores/tabs'
import { useTransfers } from './stores/transfers'
import { useUi } from './stores/ui'
import { paneRefresh, readPane } from './pane'

export default function App() {
  const [split, setSplit] = useState(50)
  const [dataIssues, setDataIssues] = useState<string[]>([])
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.api.sites
      .dataIssues()
      .then((issues) => setDataIssues(issues))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const offHostKey = window.api.events.onHostKeyPrompt((prompt) =>
      useUi.getState().addHostKey(prompt)
    )
    const offHostKeyExpired = window.api.events.onHostKeyExpired((promptId) =>
      useUi.getState().removeHostKey(promptId)
    )
    const offTransfer = window.api.events.onTransferUpdate((group) =>
      useTransfers.getState().onUpdate(group)
    )
    const offConflict = window.api.events.onConflictPrompt((prompt) =>
      useTransfers.getState().onConflict(prompt)
    )
    const offConflictExpired = window.api.events.onConflictExpired((transferId) =>
      useTransfers.getState().onConflictExpired(transferId)
    )
    const offSync = window.api.events.onSyncUpdate((job) => {
      const before = useSync.getState().jobs.find((item) => item.id === job.id)
      useSync.getState().onUpdate(job)
      if (before && before.status === 'running' && job.status !== 'running') {
        void paneRefresh('local')
        void paneRefresh('remote')
      }
    })
    const offClosed = window.api.events.onSessionClosed((sessionId) =>
      useTabs.getState().handleClosed(sessionId)
    )
    void useFiles.getState().initLocal()
    void useSites.getState().loadSites()
    void useTransfers.getState().hydrate()
    return () => {
      offHostKey()
      offHostKeyExpired()
      offTransfer()
      offConflict()
      offConflictExpired()
      offSync()
      offClosed()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F5') return
      event.preventDefault()
      if (event.repeat) return
      if (!readPane('local').loading) void paneRefresh('local')
      if (!readPane('remote').loading) void paneRefresh('remote')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const percent = ((event.clientX - rect.left) / rect.width) * 100
      setSplit(Math.min(80, Math.max(20, percent)))
    }
    const onUp = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
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

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      {dataIssues.length > 0 && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[12px] text-red-700 dark:text-red-300">
          <TriangleAlert size={14} className="mt-px shrink-0 text-red-500" />
          <div className="min-w-0 flex-1">
            {dataIssues.map((issue) => (
              <div key={issue} className="truncate" title={issue}>
                {issue}
              </div>
            ))}
          </div>
          <button
            className="shrink-0 rounded px-1.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 hover:text-red-800 dark:hover:text-red-200"
            title="知道了"
            onClick={() => setDataIssues([])}
          >
            知道了
          </button>
        </div>
      )}
      <TabBar />
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <div ref={containerRef} className="flex min-h-0 flex-1">
          <div className="flex min-w-0" style={{ width: `${split}%` }}>
            <FilePane side="local" />
          </div>
          <div
            className="group flex w-2 shrink-0 cursor-col-resize justify-center"
            onMouseDown={() => {
              dragging.current = true
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
            }}
          >
            <div className="my-3 w-0.5 rounded-full transition-colors group-hover:bg-blue-400" />
          </div>
          <div className="flex min-w-0 flex-1">
            <FilePane side="remote" />
          </div>
        </div>
        <TransferPanel />
      </div>
      <StatusBar />
      <SiteManagerDialog />
      <SyncDialog />
      <HostKeyDialog />
      <ConflictDialog />
      <ChmodDialog />
      <PromptDialog />
      <ContextMenu />
    </div>
  )
}
