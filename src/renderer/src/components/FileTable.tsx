import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { File as FileIcon, Folder, Link2 } from 'lucide-react'
import { formatDate, formatSize, modeToPermissionString } from '@shared/format'
import type { FileEntry } from '@shared/types'
import { activateEntry, commitRename, finishRename, openContextMenu } from '../actions'
import {
  paneNavigateUp,
  paneSetSelected,
  paneSetSort,
  paneSortedEntries,
  usePane
} from '../pane'
import {
  columnTemplate,
  type ColumnKey,
  useColumns
} from '../stores/columns'
import { useUi } from '../stores/ui'
import type { PaneSide, SortKey } from '../types'

const TYPE_LABELS: Record<string, string> = {
  directory: '文件夹',
  file: '文件',
  symlink: '链接',
  other: '其他'
}

function parentEntry(parentPath: string): FileEntry {
  return {
    name: '..',
    path: parentPath,
    type: 'directory',
    size: 0,
    mtime: 0,
    atime: 0,
    mode: 0o040755,
    isSymlink: false
  }
}

function HeaderCell({
  side,
  sortKey,
  label,
  align = 'left',
  onResizeStart,
  onReset
}: {
  side: PaneSide
  sortKey: SortKey
  label: string
  align?: 'left' | 'right'
  onResizeStart: (event: MouseEvent, key: ColumnKey) => void
  onReset: (key: ColumnKey) => void
}) {
  const pane = usePane(side)
  const active = pane.sortKey === sortKey
  return (
    <div className="relative flex min-w-0 items-center border-r border-gray-300 last:border-r-0">
      <button
        className={`flex min-w-0 flex-1 items-center truncate whitespace-nowrap px-2 hover:text-blue-700 ${
          align === 'right' ? 'justify-end' : ''
        } ${active ? 'font-semibold text-gray-800' : ''}`}
        onClick={() => paneSetSort(side, sortKey)}
        title={`按${label}排序`}
      >
        {label}
        {active && <span className="ml-0.5 text-[10px]">{pane.sortAsc ? '▲' : '▼'}</span>}
      </button>
      <div
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize border-r border-transparent hover:border-blue-500 hover:bg-blue-300/50"
        title="拖动调整列宽，双击恢复默认"
        onMouseDown={(event) => onResizeStart(event, sortKey)}
        onDoubleClick={() => onReset(sortKey)}
      />
    </div>
  )
}

function RenameInput({
  target,
  initial,
  side
}: {
  target: string
  initial: string
  side: PaneSide
}) {
  const [value, setValue] = useState(initial)

  const commit = (): void => {
    const trimmed = value.trim()
    if (!trimmed || trimmed.includes('/') || trimmed === initial) {
      finishRename()
      return
    }
    void commitRename(target, trimmed, side)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation()
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') finishRename()
  }

  return (
    <input
      autoFocus
      className="h-5 w-full min-w-0 rounded border border-blue-500 bg-white px-1 text-[13px] text-gray-900 outline-none"
      value={value}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    />
  )
}

export function FileTable({ side }: { side: PaneSide }) {
  const pane = usePane(side)
  const renaming = useUi((state) => state.renaming)
  const widths = useColumns((state) => state.widths[side])
  const setColumnWidth = useColumns((state) => state.setWidth)
  const resetColumn = useColumns((state) => state.resetColumn)
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<number | null>(null)
  const typeAheadRef = useRef({ buffer: '', at: 0 })
  const resizeRef = useRef<{ key: ColumnKey; startX: number; startWidth: number } | null>(null)
  const template = columnTemplate(widths)

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent): void => {
      const drag = resizeRef.current
      if (!drag) return
      setColumnWidth(side, drag.key, drag.startWidth + (event.clientX - drag.startX))
    }
    const onUp = (): void => {
      if (!resizeRef.current) return
      resizeRef.current = null
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setColumnWidth, side])

  const startResize = (event: MouseEvent, key: ColumnKey): void => {
    event.preventDefault()
    event.stopPropagation()
    const cell = (event.currentTarget as HTMLElement).parentElement
    resizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: cell?.getBoundingClientRect().width ?? 0
    }
    document.body.style.cursor = 'col-resize'
  }

  const resetColumnWidth = (key: ColumnKey): void => resetColumn(side, key)

  const entries = useMemo(
    () => paneSortedEntries(side),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.listing, pane.sortKey, pane.sortAsc, side]
  )

  const rows = useMemo(() => {
    const parent = pane.listing?.parent
    return parent ? [parentEntry(parent), ...entries] : entries
  }, [entries, pane.listing?.parent])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 15
  })

  const onRowClick = (event: MouseEvent, index: number): void => {
    const entry = rows[index]
    scrollRef.current?.focus()
    if (entry.name === '..') return
    const selected = pane.selected
    if (event.shiftKey && anchorRef.current !== null) {
      const start = Math.min(anchorRef.current, index)
      const end = Math.max(anchorRef.current, index)
      paneSetSelected(
        side,
        rows.slice(start, end + 1).map((item) => item.name)
      )
    } else if (event.ctrlKey || event.metaKey) {
      anchorRef.current = index
      paneSetSelected(
        side,
        selected.includes(entry.name)
          ? selected.filter((name) => name !== entry.name)
          : [...selected, entry.name]
      )
    } else {
      anchorRef.current = index
      paneSetSelected(side, [entry.name])
    }
  }

  const selectIndex = (index: number): void => {
    const entry = rows[index]
    if (!entry || entry.name === '..') return
    anchorRef.current = index
    paneSetSelected(side, [entry.name])
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const now = Date.now()
    const state = typeAheadRef.current
    const buffer = now - state.at < 800 ? state.buffer + key : key
    state.at = now
    const match = rows.findIndex(
      (entry) => entry.name !== '..' && entry.name.toLowerCase().startsWith(buffer)
    )
    if (match !== -1) {
      state.buffer = buffer
      event.preventDefault()
      selectIndex(match)
      return
    }
    const fallback = rows.findIndex(
      (entry) => entry.name !== '..' && entry.name.toLowerCase().startsWith(key)
    )
    if (fallback !== -1) {
      state.buffer = key
      event.preventDefault()
      selectIndex(fallback)
      return
    }
    state.buffer = ''
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid w-full border-b border-gray-300 bg-gray-100 text-gray-600"
        style={{ gridTemplateColumns: template }}
      >
        <HeaderCell
          side={side}
          sortKey="name"
          label="名称"
          onResizeStart={startResize}
          onReset={resetColumnWidth}
        />
        <HeaderCell
          side={side}
          sortKey="size"
          label="大小"
          align="right"
          onResizeStart={startResize}
          onReset={resetColumnWidth}
        />
        <HeaderCell
          side={side}
          sortKey="type"
          label="类型"
          onResizeStart={startResize}
          onReset={resetColumnWidth}
        />
        <HeaderCell
          side={side}
          sortKey="mtime"
          label="修改时间"
          onResizeStart={startResize}
          onReset={resetColumnWidth}
        />
        <HeaderCell
          side={side}
          sortKey="permissions"
          label="权限"
          onResizeStart={startResize}
          onReset={resetColumnWidth}
        />
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto bg-white outline-none"
        onKeyDown={onListKeyDown}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('[data-row]')) {
            paneSetSelected(side, [])
          }
        }}
      >
        {rows.length === 0 ? (
          <div className="p-6 text-center text-gray-400">
            {pane.loading ? '加载中…' : '目录为空'}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = rows[virtualRow.index]
              const isParent = entry.name === '..'
              const isSelected = !isParent && pane.selected.includes(entry.name)
              const isRenaming =
                !isParent &&
                renaming !== null &&
                renaming.side === side &&
                renaming.path === entry.path
              return (
                <div
                  key={isParent ? '..' : entry.path}
                  data-row
                  draggable={!isParent && !isRenaming}
                  className={`grid absolute left-0 top-0 h-6 w-full items-center cursor-default ${
                    isSelected
                      ? 'bg-blue-600 text-white'
                      : virtualRow.index % 2 === 1
                        ? 'bg-gray-50 hover:bg-blue-50'
                        : 'hover:bg-blue-50'
                  }`}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    gridTemplateColumns: template
                  }}
                  onClick={(event) => onRowClick(event, virtualRow.index)}
                  onDoubleClick={() => {
                    if (isParent) void paneNavigateUp(side)
                    else activateEntry(side, entry)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    if (isParent) return
                    if (!pane.selected.includes(entry.name)) {
                      paneSetSelected(side, [entry.name])
                    }
                    openContextMenu(side, entry, event.clientX, event.clientY)
                  }}
                  onDragStart={(event) => {
                    if (isParent) {
                      event.preventDefault()
                      return
                    }
                    const names = pane.selected.includes(entry.name)
                      ? pane.selected
                      : [entry.name]
                    if (!pane.selected.includes(entry.name)) {
                      paneSetSelected(side, [entry.name])
                    }
                    const paths = names
                      .map((name) => rows.find((item) => item.name === name)?.path)
                      .filter((path): path is string => Boolean(path))
                    event.dataTransfer.setData(
                      'application/x-filetrans',
                      JSON.stringify({ side, paths })
                    )
                    event.dataTransfer.setData('text/plain', paths.join('\n'))
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                >
                  <div className="flex min-w-0 items-center gap-1.5 px-2">
                    {entry.type === 'directory' ? (
                      <Folder
                        size={14}
                        className={`shrink-0 ${isParent ? 'text-gray-400' : 'text-amber-500'}`}
                      />
                    ) : entry.isSymlink ? (
                      <Link2 size={14} className="shrink-0 text-sky-500" />
                    ) : (
                      <FileIcon
                        size={14}
                        className={`shrink-0 ${isSelected ? 'text-white' : 'text-gray-400'}`}
                      />
                    )}
                    {isRenaming ? (
                      <RenameInput target={entry.path} initial={entry.name} side={side} />
                    ) : (
                      <span
                        className={`truncate ${isParent ? 'text-gray-500' : ''}`}
                        title={entry.name}
                      >
                        {entry.name}
                      </span>
                    )}
                  </div>
                  <div
                    className="min-w-0 truncate px-2 text-right tabular-nums"
                    title={entry.type === 'directory' ? undefined : formatSize(entry.size)}
                  >
                    {entry.type === 'directory' ? '' : formatSize(entry.size)}
                  </div>
                  <div className="min-w-0 truncate px-2" title={TYPE_LABELS[entry.type]}>
                    {TYPE_LABELS[entry.type]}
                  </div>
                  <div className="min-w-0 truncate px-2 tabular-nums" title={formatDate(entry.mtime)}>
                    {formatDate(entry.mtime)}
                  </div>
                  <div
                    className={`min-w-0 truncate px-2 font-mono ${isParent ? 'text-gray-400' : ''}`}
                    title={isParent ? undefined : modeToPermissionString(entry.mode)}
                  >
                    {isParent ? '' : modeToPermissionString(entry.mode)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
