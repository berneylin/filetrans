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
  name: 140,
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

const COLUMN_KEYS: ColumnKey[] = ['name', 'size', 'type', 'mtime', 'permissions']

export function preferredWidth(widths: ColumnWidths, key: ColumnKey): number {
  const value = widths[key]
  return typeof value === 'number' ? Math.max(MIN_WIDTHS[key], value) : MIN_WIDTHS[key]
}

export function columnTemplate(widths: ColumnWidths): string {
  const name = widths.name === 'auto' ? 'minmax(140px, 1fr)' : `${preferredWidth(widths, 'name')}px`
  return [name, ...COLUMN_KEYS.slice(1).map((key) => `${preferredWidth(widths, key)}px`)].join(' ')
}

export function fitColumnTemplate(widths: ColumnWidths, available: number): string {
  if (!(available > 0)) return columnTemplate(widths)
  const budget = Math.floor(available)
  const preferred = COLUMN_KEYS.map((key) => preferredWidth(widths, key))
  const total = preferred.reduce((sum, width) => sum + width, 0)

  let fitted: number[]
  if (total <= budget) {
    if (widths.name !== 'auto') return preferred.map((width) => `${width}px`).join(' ')
    fitted = [...preferred]
    fitted[0] = budget - (total - preferred[0])
  } else {
    const deficit = total - budget
    const slack = preferred.map((width, index) => width - MIN_WIDTHS[COLUMN_KEYS[index]])
    const totalSlack = slack.reduce((sum, value) => sum + value, 0)
    fitted =
      totalSlack >= deficit
        ? preferred.map((width, index) =>
            Math.max(MIN_WIDTHS[COLUMN_KEYS[index]], width - (deficit * slack[index]) / totalSlack)
          )
        : preferred.map((width) => (width * budget) / total)
  }

  const rounded = fitted.map((width) => Math.floor(width))
  rounded[0] += Math.max(0, Math.round(budget - rounded.reduce((sum, width) => sum + width, 0)))
  return rounded.map((width) => `${width}px`).join(' ')
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
