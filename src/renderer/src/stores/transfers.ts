import { create } from 'zustand'
import type {
  ConflictPrompt,
  ConflictResolution,
  TransferDirection,
  TransferGroup
} from '@shared/types'
import { errorMessage } from '../utils/errors'
import { useSettings } from './settings'

interface TransfersStore {
  groups: TransferGroup[]
  conflicts: ConflictPrompt[]
  error: string | null
  start: (
    sessionId: string,
    direction: TransferDirection,
    sources: string[],
    targetDir: string
  ) => Promise<void>
  cancel: (id: string) => Promise<void>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  onUpdate: (group: TransferGroup) => void
  onConflict: (prompt: ConflictPrompt) => void
  onConflictExpired: (transferId: string) => void
  resolveConflict: (resolution: ConflictResolution) => Promise<void>
  clearFinished: () => void
  setError: (message: string | null) => void
}

export const useTransfers = create<TransfersStore>((set, get) => ({
  groups: [],
  conflicts: [],
  error: null,

  start: async (sessionId, direction, sources, targetDir) => {
    if (sources.length === 0) return
    set({ error: null })
    const settings = useSettings.getState()
    try {
      await window.api.transfers.start({
        sessionId,
        direction,
        sources,
        targetDir,
        recursive: true,
        options: {
          resume: settings.resume,
          retries: settings.retries,
          concurrency: settings.concurrency,
          preserveTimestamps: settings.preserveTimestamps,
          preservePermissions: settings.preservePermissions
        }
      })
    } catch (err) {
      const message = errorMessage(err)
      if (!message.includes('已取消') && !message.includes('跳过')) {
        set({ error: message })
      } else if (message.includes('跳过')) {
        set({ error: message })
      }
    }
  },

  cancel: async (id) => {
    try {
      await window.api.transfers.cancel(id)
    } catch {
      /* 忽略取消失败 */
    }
  },

  pause: async (id) => {
    try {
      await window.api.transfers.pause(id)
    } catch {
      /* 忽略暂停失败 */
    }
  },

  resume: async (id) => {
    try {
      await window.api.transfers.resume(id)
    } catch {
      /* 忽略恢复失败 */
    }
  },

  onUpdate: (group) => {
    set((state) => {
      const exists = state.groups.some((g) => g.id === group.id)
      const groups = exists
        ? state.groups.map((g) => (g.id === group.id ? group : g))
        : [...state.groups, group]
      return { groups }
    })
  },

  onConflict: (prompt) =>
    set((state) =>
      state.conflicts.some((item) => item.transferId === prompt.transferId)
        ? state
        : { conflicts: [...state.conflicts, prompt] }
    ),

  onConflictExpired: (transferId) =>
    set((state) => ({
      conflicts: state.conflicts.filter((item) => item.transferId !== transferId)
    })),

  resolveConflict: async (resolution) => {
    const [prompt, ...rest] = get().conflicts
    if (!prompt) return
    set({ conflicts: rest })
    try {
      await window.api.transfers.resolveConflict(prompt.transferId, resolution)
    } catch {
      /* 忽略响应失败 */
    }
  },

  clearFinished: () => {
    set((state) => ({
      groups: state.groups.filter(
        (group) =>
          group.status === 'active' ||
          group.status === 'pending' ||
          group.status === 'paused'
      )
    }))
  },

  setError: (message) => set({ error: message })
}))
