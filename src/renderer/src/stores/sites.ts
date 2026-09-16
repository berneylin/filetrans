import { create } from 'zustand'
import type { SiteConfig } from '@shared/types'

interface SitesStore {
  sites: SiteConfig[]
  loadSites: () => Promise<void>
}

export const useSites = create<SitesStore>((set) => ({
  sites: [],

  loadSites: async () => {
    try {
      set({ sites: await window.api.sites.list() })
    } catch {
      /* 忽略站点加载失败 */
    }
  }
}))
