import { create } from 'zustand'
import type { SyncJob } from '@shared/types'

interface SyncStore {
  jobs: SyncJob[]
  onUpdate: (job: SyncJob) => void
  cancel: (id: string) => Promise<void>
  clearFinished: () => void
}

export const useSync = create<SyncStore>((set) => ({
  jobs: [],

  onUpdate: (job) => {
    set((state) => {
      const exists = state.jobs.some((item) => item.id === job.id)
      const jobs = exists
        ? state.jobs.map((item) => (item.id === job.id ? job : item))
        : [...state.jobs, job]
      return { jobs }
    })
  },

  cancel: async (id) => {
    try {
      await window.api.sync.cancel(id)
    } catch {
      /* 忽略取消失败 */
    }
  },

  clearFinished: () => {
    set((state) => ({ jobs: state.jobs.filter((job) => job.status === 'running') }))
    void window.api.sync.clearFinished().catch(() => {
      /* 主进程不可用时忽略 */
    })
  }
}))
