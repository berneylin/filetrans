import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TransferOptions } from '@shared/types'

interface SettingsStore extends TransferOptions {
  syncExclude: string
  syncDelete: boolean
  syncCompress: boolean
  syncBannedPaths: string
  syncLastLocal: string
  syncLastRemote: Record<string, string>
  update: (patch: Partial<TransferOptions> & Partial<{
    syncExclude: string
    syncDelete: boolean
    syncCompress: boolean
    syncBannedPaths: string
  }>) => void
  rememberSyncPaths: (local: string, remote: string, siteId?: string) => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      resume: true,
      retries: 2,
      concurrency: 8,
      fileConcurrency: 3,
      preserveTimestamps: true,
      preservePermissions: true,
      syncExclude: '.venv*',
      syncDelete: false,
      syncCompress: true,
      syncBannedPaths: '',
      syncLastLocal: '',
      syncLastRemote: {},
      update: (patch) => set(patch),
      rememberSyncPaths: (local, remote, siteId) =>
        set((state) => ({
          syncLastLocal: local,
          syncLastRemote: siteId
            ? { ...state.syncLastRemote, [siteId]: remote }
            : state.syncLastRemote
        }))
    }),
    { name: 'filetrans-transfer-settings' }
  )
)
