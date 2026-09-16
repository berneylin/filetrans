import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TransferOptions } from '@shared/types'

interface SettingsStore extends TransferOptions {
  syncExclude: string
  syncDelete: boolean
  syncCompress: boolean
  update: (patch: Partial<TransferOptions> & Partial<{
    syncExclude: string
    syncDelete: boolean
    syncCompress: boolean
  }>) => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      resume: true,
      retries: 2,
      concurrency: 8,
      preserveTimestamps: true,
      preservePermissions: true,
      syncExclude: '.venv*',
      syncDelete: false,
      syncCompress: true,
      update: (patch) => set(patch)
    }),
    { name: 'filetrans-transfer-settings' }
  )
)
