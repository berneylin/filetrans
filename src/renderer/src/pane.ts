import type { DirListing, FileEntry } from '@shared/types'
import { useFiles } from './stores/files'
import { useTabs } from './stores/tabs'
import type { PaneSide, SortKey } from './types'
import { sortEntries } from './utils/sort'

export interface PaneData {
  path: string
  listing: DirListing | null
  selected: string[]
  sortKey: SortKey
  sortAsc: boolean
  loading: boolean
  error: string | null
  connected: boolean
  canGoBack: boolean
}

const REMOTE_EMPTY: PaneData = {
  path: '',
  listing: null,
  selected: [],
  sortKey: 'name',
  sortAsc: true,
  loading: false,
  error: null,
  connected: false,
  canGoBack: false
}

function tabToPane(tab: ReturnType<typeof useTabs.getState>['tabs'][number] | null): PaneData {
  if (!tab) return REMOTE_EMPTY
  return {
    path: tab.path,
    listing: tab.listing,
    selected: tab.selected,
    sortKey: tab.sortKey,
    sortAsc: tab.sortAsc,
    loading: tab.loading,
    error: tab.error,
    connected: tab.status === 'connected',
    canGoBack: tab.back.length > 0
  }
}

export function usePane(side: PaneSide): PaneData {
  const local = useFiles((state) => state.local)
  const tab = useTabs((state) => state.tabs.find((item) => item.id === state.activeId) ?? null)
  if (side === 'local') return { ...local, connected: true, canGoBack: local.back.length > 0 }
  return tabToPane(tab)
}

export function readPane(side: PaneSide): PaneData {
  if (side === 'local') {
    const local = useFiles.getState().local
    return { ...local, connected: true, canGoBack: local.back.length > 0 }
  }
  return tabToPane(useTabs.getState().activeTab())
}

export function paneConnected(side: PaneSide): boolean {
  return readPane(side).connected
}

export function paneRemoteSessionId(): string | null {
  const tab = useTabs.getState().activeTab()
  if (!tab || tab.status !== 'connected') return null
  return tab.sessionId ?? null
}

export function paneSetSelected(side: PaneSide, names: string[]): void {
  if (side === 'local') {
    useFiles.getState().setSelected(names)
    return
  }
  const id = useTabs.getState().activeId
  if (id) useTabs.getState().setSelected(id, names)
}

export function paneSetSort(side: PaneSide, key: SortKey): void {
  if (side === 'local') {
    useFiles.getState().setSort(key)
    return
  }
  const id = useTabs.getState().activeId
  if (id) useTabs.getState().setSort(id, key)
}

export function paneSortedEntries(side: PaneSide): FileEntry[] {
  const pane = readPane(side)
  return sortEntries(pane.listing?.entries ?? [], pane.sortKey, pane.sortAsc)
}

export function paneSelectedEntries(side: PaneSide): FileEntry[] {
  const pane = readPane(side)
  const selected = new Set(pane.selected)
  return (pane.listing?.entries ?? []).filter((entry) => selected.has(entry.name))
}

export function paneNavigate(side: PaneSide, path: string): Promise<boolean> {
  if (side === 'local') return useFiles.getState().navigate(path)
  const id = useTabs.getState().activeId
  if (!id) return Promise.resolve(false)
  return useTabs.getState().navigate(id, path)
}

export function paneGoBack(side: PaneSide): Promise<void> {
  if (side === 'local') return useFiles.getState().goBack()
  const id = useTabs.getState().activeId
  if (!id) return Promise.resolve()
  return useTabs.getState().goBack(id)
}

export function paneRefresh(side: PaneSide): Promise<void> {
  if (side === 'local') return useFiles.getState().refresh()
  const id = useTabs.getState().activeId
  if (!id) return Promise.resolve()
  return useTabs.getState().refresh(id)
}

export function paneNavigateUp(side: PaneSide): Promise<void> {
  if (side === 'local') return useFiles.getState().navigateUp()
  const id = useTabs.getState().activeId
  if (!id) return Promise.resolve()
  return useTabs.getState().navigateUp(id)
}
