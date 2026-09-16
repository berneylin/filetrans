import { create } from 'zustand'
import type { DirListing, FileEntry } from '@shared/types'
import type { SortKey } from '../types'
import { errorMessage } from '../utils/errors'
import { sortEntries } from '../utils/sort'
import { useVisits } from './visits'

export interface PaneState {
  path: string
  listing: DirListing | null
  selected: string[]
  sortKey: SortKey
  sortAsc: boolean
  loading: boolean
  error: string | null
  back: string[]
}

const MAX_HISTORY = 50

function emptyPane(): PaneState {
  return {
    path: '',
    listing: null,
    selected: [],
    sortKey: 'name',
    sortAsc: true,
    loading: false,
    error: null,
    back: []
  }
}

function pushBack(stack: string[], path: string): string[] {
  return [...stack, path].slice(-MAX_HISTORY)
}

interface FilesStore {
  local: PaneState
  initLocal: () => Promise<void>
  load: (path?: string) => Promise<boolean>
  navigate: (path: string) => Promise<boolean>
  goBack: () => Promise<void>
  refresh: () => Promise<void>
  navigateUp: () => Promise<void>
  setSelected: (names: string[]) => void
  setSort: (key: SortKey) => void
  sortedEntries: () => FileEntry[]
  selectedEntries: () => FileEntry[]
}

export const useFiles = create<FilesStore>((set, get) => {
  const patchPane = (patch: Partial<PaneState>): void => {
    set((state) => ({ local: { ...state.local, ...patch } }))
  }

  const load = async (target?: string): Promise<boolean> => {
    const pane = get().local
    patchPane({ loading: true, error: null })
    try {
      const path = target || pane.path || (await window.api.local.home())
      const listing = await window.api.local.list(path)
      patchPane({ path: listing.path, listing, loading: false, selected: [] })
      useVisits.getState().recordLocal(listing.path)
      return true
    } catch (err) {
      patchPane({ loading: false, error: errorMessage(err) })
      return false
    }
  }

  const navigate = async (target: string): Promise<boolean> => {
    const previous = get().local.path
    const ok = await load(target)
    if (ok) {
      const current = get().local
      if (previous && current.path !== previous) {
        patchPane({ back: pushBack(current.back, previous) })
      }
    }
    return ok
  }

  const goBack = async (): Promise<void> => {
    const pane = get().local
    const target = pane.back[pane.back.length - 1]
    if (!target) return
    patchPane({ back: pane.back.slice(0, -1) })
    await load(target)
  }

  return {
    local: emptyPane(),

    initLocal: async () => {
      await load()
    },

    load,
    navigate,
    goBack,

    refresh: async () => {
      const pane = get().local
      if (!pane.path) {
        await load()
        return
      }
      await load(pane.path)
    },

    navigateUp: async () => {
      const parent = get().local.listing?.parent
      if (parent) await navigate(parent)
    },

    setSelected: (names) => patchPane({ selected: names }),

    setSort: (key) => {
      const pane = get().local
      if (pane.sortKey === key) patchPane({ sortAsc: !pane.sortAsc })
      else patchPane({ sortKey: key, sortAsc: true })
    },

    sortedEntries: () => {
      const pane = get().local
      return sortEntries(pane.listing?.entries ?? [], pane.sortKey, pane.sortAsc)
    },

    selectedEntries: () => {
      const pane = get().local
      const selected = new Set(pane.selected)
      return (pane.listing?.entries ?? []).filter((entry) => selected.has(entry.name))
    }
  }
})
