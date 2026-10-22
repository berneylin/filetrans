import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronUp, CornerLeftUp, Folder, Inbox, Link2, LoaderCircle } from 'lucide-react'
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
  fitColumnTemplate,
  preferredWidth,
  type ColumnKey,
  useColumns
} from '../stores/columns'
import { useUi } from '../stores/ui'
import type { PaneSide, SortKey } from '../types'
import { FILE_ICONS, fileKind } from '../utils/fileIcon'

const TYPE_LABELS: Record<string, string> = {
  directory: '文件夹',
  file: '文件',
  symlink: '链接',
  other: '其他'
}

const LIST_BOTTOM_PADDING = 48

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

function EntryIcon({ entry, isParent }: { entry: FileEntry; isParent: boolean }) {
  if (isParent) return <CornerLeftUp size={14} className="shrink-0 text-ui-400" />
  if (entry.type === 'directory') {
    return <Folder size={15} className="shrink-0 fill-amber-200 dark:fill-amber-400/30 text-amber-500" />
  }
  if (entry.isSymlink) return <Link2 size={14} className="shrink-0 text-sky-500" />
  const { icon: Icon, className } = FILE_ICONS[fileKind(entry.name)]
  return <Icon size={14} className={`shrink-0 ${className}`} />
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
    <div className="relative flex min-w-0 items-center after:absolute after:top-1.5 after:right-0 after:bottom-1.5 after:w-px after:bg-ui-200 last:after:hidden">
      <button
        className={`flex h-full min-w-0 flex-1 items-center gap-0.5 truncate whitespace-nowrap px-2 transition-colors hover:text-ui-800 ${
          align === 'right' ? 'justify-end' : ''
        } ${active ? 'font-medium text-blue-600 dark:text-blue-400' : ''}`}
        onClick={() => paneSetSort(side, sortKey)}
        title={`按${label}排序`}
      >
        <span className="truncate">{label}</span>
        {active &&
          (pane.sortAsc ? (
            <ChevronUp size={12} className="shrink-0" />
          ) : (
            <ChevronDown size={12} className="shrink-0" />
          ))}
      </button>
      <div
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize rounded-sm hover:bg-blue-400/40"
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
  const committingRef = useRef(false)

  const commit = (): void => {
    if (committingRef.current) return
    const trimmed = value.trim()
    if (!trimmed || trimmed.includes('/') || trimmed === initial) {
      finishRename()
      return
    }
    committingRef.current = true
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
      className="h-5 w-full min-w-0 rounded border border-blue-500 bg-ui-0 px-1 text-[13px] text-ui-900 outline-none ring-2 ring-blue-500/20"
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
  const [available, setAvailable] = useState(0)

  const selectedSet = useMemo(() => new Set(pane.selected), [pane.selected])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    anchorRef.current = null
    typeAheadRef.current = { buffer: '', at: 0 }
  }, [pane.path])

  useEffect(() => {
    const styles = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect
    }
    return () => {
      document.body.style.cursor = styles.cursor
      document.body.style.userSelect = styles.userSelect
    }
  }, [])

  const measureAvailable = useCallback((): void => {
    const width = scrollRef.current?.clientWidth ?? 0
    setAvailable((prev) => (prev === width ? prev : width))
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(measureAvailable)
    observer.observe(element)
    return () => observer.disconnect()
  }, [measureAvailable])

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
      document.body.style.userSelect = ''
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
    const rendered = cell?.getBoundingClientRect().width ?? 0
    resizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: Math.max(preferredWidth(widths, key), rendered)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const resetColumnWidth = (key: ColumnKey): void => resetColumn(side, key)

  const template = fitColumnTemplate(widths, available)

  const entries = useMemo(
    () => paneSortedEntries(side),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane.listing, pane.sortKey, pane.sortAsc, side]
  )

  const rows = useMemo(() => {
    const parent = pane.listing?.parent
    return parent ? [parentEntry(parent), ...entries] : entries
  }, [entries, pane.listing?.parent])

  useLayoutEffect(measureAvailable, [measureAvailable, rows.length])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 15
  })

  useEffect(() => {
    if (!renaming || renaming.side !== side) return
    const index = rows.findIndex((entry) => entry.path === renaming.path)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming?.side, renaming?.path, side])

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

  const currentRowIndex = (): number =>
    rows.findIndex((entry) => entry.name !== '..' && pane.selected.includes(entry.name))

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      event.stopPropagation()
      paneSetSelected(side, entries.map((entry) => entry.name))
      anchorRef.current = entries.length > 0 ? rows.length - entries.length : null
      typeAheadRef.current = { buffer: '', at: 0 }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      let next = currentRowIndex()
      const step = event.key === 'ArrowDown' ? 1 : -1
      for (;;) {
        next += step
        if (next < 0 || next >= rows.length) return
        if (rows[next].name !== '..') break
      }
      typeAheadRef.current = { buffer: '', at: 0 }
      selectIndex(next)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const selected = entries.filter((entry) => selectedSet.has(entry.name))
      if (selected.length === 1) activateEntry(side, selected[0])
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      void paneNavigateUp(side)
      return
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    const key = event.key.toLowerCase()
    const now = Date.now()
    const state = typeAheadRef.current
    const buffer = now - state.at < 800 ? state.buffer + key : key
    state.at = now
    const refining = buffer.length > 1
    const findMatch = (prefix: string): number => {
      const current = currentRowIndex()
      const start = refining && prefix === buffer ? Math.max(current, 0) : current + 1
      for (let offset = 0; offset < rows.length; offset++) {
        const index = (start + offset) % rows.length
        const entry = rows[index]
        if (entry.name !== '..' && entry.name.toLowerCase().startsWith(prefix)) return index
      }
      return -1
    }
    const match = findMatch(buffer)
    if (match !== -1) {
      state.buffer = buffer
      event.preventDefault()
      selectIndex(match)
      return
    }
    const fallback = findMatch(key)
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
        className="grid h-7 w-full shrink-0 overflow-hidden border-b border-ui-200 bg-ui-0 text-[12px] text-ui-500"
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
        className="min-h-0 flex-1 overflow-auto bg-ui-0 outline-none"
        onKeyDown={onListKeyDown}
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest('[data-row]')) {
            paneSetSelected(side, [])
          }
        }}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('[data-row]')) return
          event.preventDefault()
          paneSetSelected(side, [])
          openContextMenu(side, null, event.clientX, event.clientY)
        }}
      >
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-ui-400">
            {pane.loading ? (
              <LoaderCircle size={22} className="animate-spin text-ui-300" />
            ) : (
              <Inbox size={26} strokeWidth={1.5} className="text-ui-300" />
            )}
            <span>{pane.loading ? '加载中…' : '目录为空'}</span>
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() + LIST_BOTTOM_PADDING }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = rows[virtualRow.index]
              const isParent = entry.name === '..'
              const isSelected = !isParent && selectedSet.has(entry.name)
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
                      ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-950 dark:text-blue-50 shadow-[inset_2px_0_0_#3b82f6]'
                      : 'text-ui-700 hover:bg-ui-50'
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
                    if (!selectedSet.has(entry.name)) {
                      paneSetSelected(side, [entry.name])
                    }
                    openContextMenu(side, entry, event.clientX, event.clientY)
                  }}
                  onDragStart={(event) => {
                    if (isParent) {
                      event.preventDefault()
                      return
                    }
                    const names = selectedSet.has(entry.name) ? pane.selected : [entry.name]
                    if (!selectedSet.has(entry.name)) {
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
                  <div className="flex min-w-0 items-center gap-2 px-2">
                    <EntryIcon entry={entry} isParent={isParent} />
                    {isRenaming ? (
                      <RenameInput target={entry.path} initial={entry.name} side={side} />
                    ) : (
                      <span
                        className={`truncate ${isParent ? 'text-ui-400' : ''}`}
                        title={entry.name}
                      >
                        {entry.name}
                      </span>
                    )}
                  </div>
                  <div
                    className={`min-w-0 truncate px-2 text-right tabular-nums ${
                      isSelected ? '' : 'text-ui-600'
                    }`}
                    title={entry.type === 'directory' ? undefined : formatSize(entry.size)}
                  >
                    {entry.type === 'directory' ? '' : formatSize(entry.size)}
                  </div>
                  <div
                    className={`min-w-0 truncate px-2 ${isSelected ? '' : 'text-ui-500'}`}
                    title={TYPE_LABELS[entry.type]}
                  >
                    {TYPE_LABELS[entry.type]}
                  </div>
                  <div
                    className={`min-w-0 truncate px-2 tabular-nums ${isSelected ? '' : 'text-ui-600'}`}
                    title={formatDate(entry.mtime)}
                  >
                    {formatDate(entry.mtime)}
                  </div>
                  <div
                    className={`min-w-0 truncate px-2 font-mono text-[11.5px] ${
                      isSelected ? '' : 'text-ui-500'
                    }`}
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
