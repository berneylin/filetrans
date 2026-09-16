import type { FileEntry } from '@shared/types'
import type { SortKey } from '../types'

export function sortEntries(entries: FileEntry[], sortKey: SortKey, sortAsc: boolean): FileEntry[] {
  const direction = sortAsc ? 1 : -1
  return [...entries].sort((a, b) => {
    const dirDiff = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1)
    if (dirDiff !== 0) return dirDiff
    let result = 0
    switch (sortKey) {
      case 'name':
        result = a.name.localeCompare(b.name, 'zh-CN')
        break
      case 'size':
        result = a.size - b.size
        break
      case 'type':
        result = a.type.localeCompare(b.type)
        break
      case 'mtime':
        result = a.mtime - b.mtime
        break
      case 'permissions':
        result = a.mode - b.mode
        break
    }
    if (result === 0) result = a.name.localeCompare(b.name, 'zh-CN')
    return result * direction
  })
}
