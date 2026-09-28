import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export const MAX_RECENT_PATHS = 5

export function pushRecent(list: string[] | undefined, path: string): string[] {
  const current = list ?? []
  if (!path) return current
  return [path, ...current.filter((item) => item !== path)].slice(0, MAX_RECENT_PATHS)
}

interface VisitsStore {
  local: string[]
  remote: Record<string, string[]>
  recordLocal: (path: string) => void
  recordRemote: (siteId: string, path: string) => void
  clearLocal: () => void
  clearRemote: (siteId: string) => void
}

function sanitizeVisits(value: unknown): { local: string[]; remote: Record<string, string[]> } {
  const source = (typeof value === 'object' && value !== null ? value : {}) as {
    local?: unknown
    remote?: unknown
  }
  const local = Array.isArray(source.local)
    ? source.local.filter((item): item is string => typeof item === 'string')
    : []
  const remote: Record<string, string[]> = {}
  if (typeof source.remote === 'object' && source.remote !== null) {
    for (const [siteId, paths] of Object.entries(source.remote as Record<string, unknown>)) {
      if (Array.isArray(paths)) {
        remote[siteId] = paths.filter((item): item is string => typeof item === 'string')
      }
    }
  }
  return { local, remote }
}

export const useVisits = create<VisitsStore>()(
  persist(
    (set) => ({
      local: [],
      remote: {},
      recordLocal: (path) => set((state) => ({ local: pushRecent(state.local, path) })),
      recordRemote: (siteId, path) =>
        set((state) => ({
          remote: { ...state.remote, [siteId]: pushRecent(state.remote[siteId], path) }
        })),
      clearLocal: () => set({ local: [] }),
      clearRemote: (siteId) =>
        set((state) => {
          const remote = { ...state.remote }
          delete remote[siteId]
          return { remote }
        })
    }),
    {
      name: 'filetrans-path-history',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => sanitizeVisits(persisted),
      merge: (persisted, current) => ({ ...current, ...sanitizeVisits(persisted) })
    }
  )
)
