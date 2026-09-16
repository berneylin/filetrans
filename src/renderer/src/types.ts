import type { FileEntry } from '@shared/types'

export type PaneSide = 'local' | 'remote'

export type SortKey = 'name' | 'size' | 'type' | 'mtime' | 'permissions'

export interface MenuItem {
  label?: string
  separator?: boolean
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}

export interface ChmodTarget {
  side: PaneSide
  entries: FileEntry[]
}
