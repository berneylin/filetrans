import { create } from 'zustand'
import type { SyncJob } from '@shared/types'

interface SyncStore {
  jobs: SyncJob[]
  onUpdate: (job: SyncJob) => void
  onSuccess: (id: string, callback: () => void) => void
  cancel: (id: string) => Promise<void>
  clearFinished: () => void
}

const successCallbacks = new Map<string, () => void>()

export const useSync = create<SyncStore>((set, get) => ({
  jobs: [],

  onUpdate: (job) => {
    set((state) => {
      const exists = state.jobs.some((item) => item.id === job.id)
      const jobs = exists
        ? state.jobs.map((item) => (item.id === job.id ? job : item))
        : [...state.jobs, job]
      return { jobs }
    })
    if (job.status !== 'running') {
      const callback = successCallbacks.get(job.id)
      successCallbacks.delete(job.id)
      if (callback && job.status === 'done') callback()
    }
  },

  onSuccess: (id, callback) => {
    const job = get().jobs.find((item) => item.id === id)
    if (!job || job.status === 'running') {
      successCallbacks.set(id, callback)
      return
    }
    if (job.status === 'done') callback()
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
