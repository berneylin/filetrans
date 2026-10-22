import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ThemeMode } from '@shared/types'

interface ThemeStore {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

const DARK_QUERY = '(prefers-color-scheme: dark)'
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark']

function sanitizeMode(value: unknown): ThemeMode {
  return THEME_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : 'system'
}

export const useTheme = create<ThemeStore>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => set({ mode })
    }),
    {
      name: 'filetrans-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ mode: state.mode }),
      merge: (persisted, current) => ({
        ...current,
        mode: sanitizeMode((persisted as { mode?: unknown } | undefined)?.mode)
      })
    }
  )
)

export function resolveDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemDark)
}

function applyThemeClass(mode: ThemeMode): void {
  const dark = resolveDark(mode, window.matchMedia(DARK_QUERY).matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

function syncNativeTheme(mode: ThemeMode): void {
  void window.api
    .setTheme(mode)
    .then(() => applyThemeClass(useTheme.getState().mode))
    .catch(() => undefined)
}

export function initTheme(): void {
  const { mode } = useTheme.getState()
  applyThemeClass(mode)
  syncNativeTheme(mode)
  window
    .matchMedia(DARK_QUERY)
    .addEventListener('change', () => applyThemeClass(useTheme.getState().mode))
  useTheme.subscribe((state, prev) => {
    if (state.mode === prev.mode) return
    applyThemeClass(state.mode)
    syncNativeTheme(state.mode)
  })
}
