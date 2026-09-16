import { useEffect, useRef, useState } from 'react'
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
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

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
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <TabBar />
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <div className="flex min-w-0" style={{ width: `${split}%` }}>
          <FilePane side="local" />
        </div>
        <div
          className="w-1 cursor-col-resize border-x border-gray-300 bg-gray-200 hover:bg-blue-400"
          onMouseDown={() => {
            dragging.current = true
            document.body.style.cursor = 'col-resize'
          }}
        />
        <div className="flex min-w-0 flex-1">
          <FilePane side="remote" />
        </div>
      </div>
      <TransferPanel />
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
