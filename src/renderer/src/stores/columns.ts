import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PaneSide } from '../types'

export type ColumnKey = 'name' | 'size' | 'type' | 'mtime' | 'permissions'

export interface ColumnWidths {
  name: number | 'auto'
  size: number
  type: number
  mtime: number
  permissions: number
}

export type PaneWidths = Record<PaneSide, ColumnWidths>

export const MIN_WIDTHS: Record<ColumnKey, number> = {
  name: 100,
  size: 52,
  type: 48,
  mtime: 88,
  permissions: 74
}

export const DEFAULT_COLUMNS: ColumnWidths = {
  name: 'auto',
  size: 84,
  type: 64,
  mtime: 136,
  permissions: 100
}

export function columnTemplate(widths: ColumnWidths): string {
  const name = widths.name === 'auto' ? 'minmax(140px, 1fr)' : `${Math.max(MIN_WIDTHS.name, widths.name)}px`
  const size = Math.max(MIN_WIDTHS.size, widths.size)
  const type = Math.max(MIN_WIDTHS.type, widths.type)
  const mtime = Math.max(MIN_WIDTHS.mtime, widths.mtime)
  const permissions = Math.max(MIN_WIDTHS.permissions, widths.permissions)
  return `${name} ${size}px ${type}px ${mtime}px ${permissions}px`
}

const DEFAULT_PANE_WIDTHS: PaneWidths = {
  local: { ...DEFAULT_COLUMNS },
  remote: { ...DEFAULT_COLUMNS }
}

function isColumnWidths(value: unknown): value is ColumnWidths {
  return typeof value === 'object' && value !== null && 'name' in value
}

interface ColumnsStore {
  widths: PaneWidths
  setWidth: (side: PaneSide, key: ColumnKey, width: number) => void
  resetColumn: (side: PaneSide, key: ColumnKey) => void
}

export const useColumns = create<ColumnsStore>()(
  persist(
    (set) => ({
      widths: DEFAULT_PANE_WIDTHS,
      setWidth: (side, key, width) =>
        set((state) => ({
          widths: {
            ...state.widths,
            [side]: {
              ...state.widths[side],
              [key]: Math.max(MIN_WIDTHS[key], Math.round(width))
            }
          }
        })),
      resetColumn: (side, key) =>
        set((state) => ({
          widths: {
            ...state.widths,
            [side]: { ...state.widths[side], [key]: DEFAULT_COLUMNS[key] }
          }
        }))
    }),
    {
      name: 'filetrans-column-widths',
      merge: (persistedState, currentState) => {
        const persisted = persistedState as { widths?: unknown } | null
        const widths = persisted?.widths
        if (isColumnWidths(widths)) {
          return { ...currentState, widths: { local: widths, remote: widths } }
        }
        if (widths && typeof widths === 'object') {
          const panes = widths as Partial<PaneWidths>
          return {
            ...currentState,
            widths: {
              local: { ...DEFAULT_COLUMNS, ...panes.local },
              remote: { ...DEFAULT_COLUMNS, ...panes.remote }
            }
          }
        }
        return currentState
      }
    }
  )
)
