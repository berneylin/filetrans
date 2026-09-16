import { create } from 'zustand'
import type { DirListing, FileEntry, SessionInfo } from '@shared/types'
import type { SortKey } from '../types'
import { errorMessage } from '../utils/errors'
import { sortEntries } from '../utils/sort'
import { useSites } from './sites'
import { useVisits } from './visits'

export type TabStatus = 'connecting' | 'connected' | 'disconnected'

export interface TabState {
  id: string
  siteId?: string
  sessionId?: string
  session?: SessionInfo
  title: string
  status: TabStatus
  error: string | null
  path: string
  listing: DirListing | null
  selected: string[]
  sortKey: SortKey
  sortAsc: boolean
  loading: boolean
  back: string[]
}

export interface OpenOverrides {
  password?: string
  passphrase?: string
}

let tabSeq = 0

const MAX_HISTORY = 50

function pushBack(stack: string[], path: string): string[] {
  return [...stack, path].slice(-MAX_HISTORY)
}

function newTab(siteId: string, title: string): TabState {
  return {
    id: `tab-${++tabSeq}`,
    siteId,
    title,
    status: 'connecting',
    error: null,
    path: '',
    listing: null,
    selected: [],
    sortKey: 'name',
    sortAsc: true,
    loading: false,
    back: []
  }
}

interface TabsStore {
  tabs: TabState[]
  activeId: string | null
  activeTab: () => TabState | null
  openSite: (siteId: string, overrides?: OpenOverrides) => Promise<void>
  closeTab: (id: string) => Promise<void>
  setActive: (id: string) => void
  load: (id: string, path?: string) => Promise<boolean>
  navigate: (id: string, path: string) => Promise<boolean>
  goBack: (id: string) => Promise<void>
  refresh: (id: string) => Promise<void>
  navigateUp: (id: string) => Promise<void>
  setSelected: (id: string, names: string[]) => void
  setSort: (id: string, key: SortKey) => void
  sortedEntries: (id: string) => FileEntry[]
  selectedEntries: (id: string) => FileEntry[]
  handleClosed: (sessionId: string) => void
}

export const useTabs = create<TabsStore>((set, get) => {
  const patchTab = (id: string, patch: Partial<TabState>): void => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab))
    }))
  }

  const load = async (id: string, target?: string): Promise<boolean> => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab || !tab.sessionId || tab.status !== 'connected') return false
    patchTab(id, { loading: true, error: null })
    try {
      const path = target || tab.path || (await window.api.sftp.home(tab.sessionId))
      const listing = await window.api.sftp.list(tab.sessionId, path)
      patchTab(id, { path: listing.path, listing, loading: false, selected: [] })
      if (tab.siteId) useVisits.getState().recordRemote(tab.siteId, listing.path)
      return true
    } catch (err) {
      patchTab(id, { loading: false, error: errorMessage(err) })
      return false
    }
  }

  const navigate = async (id: string, target: string): Promise<boolean> => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab) return false
    const previous = tab.path
    const ok = await load(id, target)
    if (ok) {
      const current = get().tabs.find((item) => item.id === id)
      if (current && previous && current.path !== previous) {
        patchTab(id, { back: pushBack(current.back, previous) })
      }
    }
    return ok
  }

  const goBack = async (id: string): Promise<void> => {
    const tab = get().tabs.find((item) => item.id === id)
    if (!tab) return
    const target = tab.back[tab.back.length - 1]
    if (!target) return
    patchTab(id, { back: tab.back.slice(0, -1) })
    await load(id, target)
  }

  return {
    tabs: [],
    activeId: null,

    activeTab: () => {
      const { tabs, activeId } = get()
      return tabs.find((tab) => tab.id === activeId) ?? null
    },

    openSite: async (siteId, overrides) => {
      const site = useSites.getState().sites.find((item) => item.id === siteId)
      if (!site) throw new Error('站点不存在')
      const tab = newTab(siteId, site.name || `${site.username}@${site.host}`)
      set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }))
      try {
        const hasOverrides =
          overrides && (overrides.password !== undefined || overrides.passphrase !== undefined)
        const session = hasOverrides
          ? await window.api.sftp.connect({
              host: site.host,
              port: site.port,
              username: site.username,
              password: overrides.password,
              privateKeyPath: site.authType === 'key' ? site.keyPath : undefined,
              passphrase: overrides.passphrase
            })
          : await window.api.sftp.connectSite(siteId)
        patchTab(tab.id, {
          sessionId: session.sessionId,
          session,
          title: site.name || `${session.username}@${session.host}`,
          status: 'connected',
          error: null
        })
        const home = await window.api.sftp.home(session.sessionId)
        const ok = await load(tab.id, site.remotePath || home)
        if (!ok && site.remotePath) await load(tab.id, home)
      } catch (err) {
        patchTab(tab.id, {
          status: 'disconnected',
          error: errorMessage(err),
          loading: false
        })
      }
    },

    closeTab: async (id) => {
      const tab = get().tabs.find((item) => item.id === id)
      if (tab?.sessionId) {
        try {
          await window.api.sftp.disconnect(tab.sessionId)
        } catch {
          /* 忽略断开异常 */
        }
      }
      set((state) => {
        const index = state.tabs.findIndex((item) => item.id === id)
        const tabs = state.tabs.filter((item) => item.id !== id)
        let activeId = state.activeId
        if (activeId === id) {
          activeId = tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null
        }
        return { tabs, activeId }
      })
    },

    setActive: (id) => set({ activeId: id }),

    load,
    navigate,
    goBack,

    refresh: async (id) => {
      const tab = get().tabs.find((item) => item.id === id)
      if (!tab) return
      if (!tab.path) {
        await load(id)
        return
      }
      await load(id, tab.path)
    },

    navigateUp: async (id) => {
      const tab = get().tabs.find((item) => item.id === id)
      const parent = tab?.listing?.parent
      if (parent) await navigate(id, parent)
    },

    setSelected: (id, names) => patchTab(id, { selected: names }),

    setSort: (id, key) => {
      const tab = get().tabs.find((item) => item.id === id)
      if (!tab) return
      if (tab.sortKey === key) patchTab(id, { sortAsc: !tab.sortAsc })
      else patchTab(id, { sortKey: key, sortAsc: true })
    },

    sortedEntries: (id) => {
      const tab = get().tabs.find((item) => item.id === id)
      if (!tab) return []
      return sortEntries(tab.listing?.entries ?? [], tab.sortKey, tab.sortAsc)
    },

    selectedEntries: (id) => {
      const tab = get().tabs.find((item) => item.id === id)
      if (!tab) return []
      const selected = new Set(tab.selected)
      return (tab.listing?.entries ?? []).filter((entry) => selected.has(entry.name))
    },

    handleClosed: (sessionId) => {
      set((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.sessionId === sessionId
            ? { ...tab, status: 'disconnected', error: '连接已断开', sessionId: undefined }
            : tab
        )
      }))
    }
  }
})
