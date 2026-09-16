import { create } from 'zustand'
import type { HostKeyPrompt } from '@shared/types'
import type { ChmodTarget, MenuItem, PaneSide } from '../types'

export interface PromptConfig {
  title: string
  label: string
  initial: string
  confirmText?: string
  onConfirm: (value: string) => void | Promise<void>
}

export interface RenameTarget {
  side: PaneSide
  path: string
  name: string
}

interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface UiStore {
  siteManagerOpen: boolean
  syncDialogOpen: boolean
  hostKeys: HostKeyPrompt[]
  prompt: PromptConfig | null
  menu: MenuState | null
  chmod: ChmodTarget | null
  renaming: RenameTarget | null
  setSiteManagerOpen: (open: boolean) => void
  setSyncDialogOpen: (open: boolean) => void
  addHostKey: (prompt: HostKeyPrompt) => void
  removeHostKey: (promptId: string) => void
  showPrompt: (prompt: PromptConfig) => void
  closePrompt: () => void
  showMenu: (x: number, y: number, items: MenuItem[]) => void
  closeMenu: () => void
  setChmod: (target: ChmodTarget | null) => void
  startRename: (target: RenameTarget) => void
  finishRename: () => void
}

export const useUi = create<UiStore>((set) => ({
  siteManagerOpen: false,
  syncDialogOpen: false,
  hostKeys: [],
  prompt: null,
  menu: null,
  chmod: null,
  renaming: null,
  setSiteManagerOpen: (open) => set({ siteManagerOpen: open }),
  setSyncDialogOpen: (open) => set({ syncDialogOpen: open }),
  addHostKey: (prompt) =>
    set((state) =>
      state.hostKeys.some((item) => item.promptId === prompt.promptId)
        ? state
        : { hostKeys: [...state.hostKeys, prompt] }
    ),
  removeHostKey: (promptId) =>
    set((state) => ({
      hostKeys: state.hostKeys.filter((item) => item.promptId !== promptId)
    })),
  showPrompt: (prompt) => set({ prompt }),
  closePrompt: () => set({ prompt: null }),
  showMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  setChmod: (target) => set({ chmod: target }),
  startRename: (target) =>
    set({ menu: null, renaming: { side: target.side, path: target.path, name: target.name } }),
  finishRename: () => set({ renaming: null })
}))

export type { MenuItem }
