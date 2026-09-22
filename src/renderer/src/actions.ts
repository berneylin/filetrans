import type { FileEntry } from '@shared/types'
import {
  paneNavigate,
  paneRefresh,
  paneRemoteSessionId,
  paneSelectedEntries,
  readPane
} from './pane'
import { useTransfers } from './stores/transfers'
import { useUi } from './stores/ui'
import type { ChmodTarget, MenuItem, PaneSide } from './types'
import { errorMessage } from './utils/errors'

function requireSession(): string {
  const sessionId = paneRemoteSessionId()
  if (!sessionId) throw new Error('未连接到服务器')
  return sessionId
}

export function refreshPane(side: PaneSide): Promise<void> {
  return paneRefresh(side)
}

export function promptMakeDirectory(side: PaneSide): void {
  const pane = readPane(side)
  useUi.getState().showPrompt({
    title: '新建目录',
    label: '目录路径（支持 a/b/c，自动创建父目录）',
    initial: '新建目录',
    onConfirm: async (name) => {
      if (side === 'local') await window.api.local.mkdir(pane.path, name)
      else await window.api.sftp.mkdir(requireSession(), pane.path, name)
      await paneRefresh(side)
    }
  })
}

export function startRename(side: PaneSide, entries?: FileEntry[]): void {
  const list = entries ?? paneSelectedEntries(side)
  if (list.length !== 1) return
  const entry = list[0]
  useUi.getState().startRename({ side, path: entry.path, name: entry.name })
}

export function finishRename(): void {
  useUi.getState().finishRename()
}

export async function commitRename(target: string, newName: string, side: PaneSide): Promise<void> {
  const trimmed = newName.trim()
  if (!trimmed || trimmed.includes('/')) {
    finishRename()
    return
  }
  try {
    if (side === 'local') await window.api.local.rename(target, trimmed)
    else await window.api.sftp.rename(requireSession(), target, trimmed)
    finishRename()
    await paneRefresh(side)
  } catch (err) {
    finishRename()
    window.alert(errorMessage(err))
  }
}

export async function deleteSelection(side: PaneSide, entries?: FileEntry[]): Promise<void> {
  const list = entries ?? paneSelectedEntries(side)
  if (list.length === 0) return
  const label = list.length === 1 ? `“${list[0].name}”` : `${list.length} 个项目`
  if (!window.confirm(`确定要删除 ${label} 吗？此操作不可恢复。`)) return
  try {
    const paths = list.map((entry) => entry.path)
    if (side === 'local') await window.api.local.remove(paths)
    else await window.api.sftp.remove(requireSession(), paths)
    await paneRefresh(side)
  } catch (err) {
    window.alert(errorMessage(err))
  }
}

export function promptChmod(side: PaneSide, entries?: FileEntry[]): void {
  const list = entries ?? paneSelectedEntries(side)
  if (list.length === 0) return
  useUi.getState().setChmod({ side, entries: list })
}

export async function applyChmod(target: ChmodTarget, mode: number): Promise<void> {
  if (target.side === 'local') {
    for (const entry of target.entries) await window.api.local.chmod(entry.path, mode)
  } else {
    const sessionId = requireSession()
    for (const entry of target.entries) {
      await window.api.sftp.chmod(sessionId, entry.path, mode)
    }
  }
  await paneRefresh(target.side)
}

export async function openInFileBrowser(target: string): Promise<void> {
  try {
    await window.api.local.openInBrowser(target)
  } catch (err) {
    window.alert(errorMessage(err))
  }
}

export async function cleanTransientFilesIn(side: PaneSide): Promise<void> {
  const pane = readPane(side)
  if (!pane.path) return
  try {
    const count =
      side === 'local'
        ? await window.api.local.cleanTransientFiles(pane.path)
        : await window.api.sftp.cleanTransientFiles(requireSession(), pane.path)
    if (count > 0) await paneRefresh(side)
    window.alert(
      count > 0 ? `已清理 ${count} 个传输临时文件` : '当前目录没有传输临时文件'
    )
  } catch (err) {
    window.alert(errorMessage(err))
  }
}

export async function transferEntries(from: PaneSide, entries: FileEntry[]): Promise<void> {
  if (entries.length === 0) return
  const sessionId = paneRemoteSessionId()
  if (!sessionId) {
    useTransfers.getState().setError('请先连接远程服务器')
    return
  }
  const to: PaneSide = from === 'local' ? 'remote' : 'local'
  const targetDir = readPane(to).path
  if (!targetDir) return
  await useTransfers
    .getState()
    .start(sessionId, from === 'local' ? 'upload' : 'download', entries.map((entry) => entry.path), targetDir)
}

export function transferSelection(side: PaneSide): void {
  void transferEntries(side, paneSelectedEntries(side))
}

export function transferPaths(from: PaneSide, paths: string[]): void {
  if (paths.length === 0) return
  const sessionId = paneRemoteSessionId()
  if (!sessionId) {
    useTransfers.getState().setError('请先连接远程服务器')
    return
  }
  const to: PaneSide = from === 'local' ? 'remote' : 'local'
  const targetDir = readPane(to).path
  if (!targetDir) return
  void useTransfers
    .getState()
    .start(sessionId, from === 'local' ? 'upload' : 'download', paths, targetDir)
}

export function activateEntry(side: PaneSide, entry: FileEntry): void {
  if (entry.type === 'directory') {
    void paneNavigate(side, entry.path)
  } else {
    void transferEntries(side, [entry])
  }
}

export function openContextMenu(
  side: PaneSide,
  entry: FileEntry | null,
  x: number,
  y: number
): void {
  if (!entry) {
    const blank: MenuItem[] = [{ label: '新建目录', onClick: () => promptMakeDirectory(side) }]
    blank.push({
      label: '清理传输临时文件',
      onClick: () => void cleanTransientFilesIn(side)
    })
    if (side === 'local') {
      blank.push({
        label: '在文件浏览器中打开',
        onClick: () => {
          const current = readPane(side).path
          if (current) void openInFileBrowser(current)
        }
      })
    }
    blank.push({ separator: true }, { label: '刷新', onClick: () => void paneRefresh(side) })
    useUi.getState().showMenu(x, y, blank)
    return
  }

  const selected = paneSelectedEntries(side)
  const hasSelection = selected.length > 0
  const remoteReady = paneRemoteSessionId() !== null
  const canTransfer = side === 'local' ? remoteReady : true

  const items: MenuItem[] = []
  if (entry && entry.type === 'directory') {
    items.push({ label: '打开', onClick: () => activateEntry(side, entry) })
    if (side === 'local') {
      items.push({
        label: '在文件浏览器中打开',
        onClick: () => void openInFileBrowser(entry.path)
      })
    }
  }
  if (entry && entry.type !== 'directory') {
    items.push({
      label: side === 'local' ? '上传' : '下载',
      disabled: !canTransfer,
      onClick: () => void transferEntries(side, [entry])
    })
  }
  if (hasSelection) {
    items.push({
      label:
        side === 'local' ? `上传选中的 ${selected.length} 项` : `下载选中的 ${selected.length} 项`,
      disabled: !canTransfer,
      onClick: () => void transferEntries(side, selected)
    })
  }
  if (items.length > 0) items.push({ separator: true })
  items.push(
    { label: '重命名', disabled: selected.length !== 1, onClick: () => startRename(side, selected) },
    {
      label: '删除',
      danger: true,
      disabled: !hasSelection,
      onClick: () => void deleteSelection(side, selected)
    },
    { label: '权限…', disabled: !hasSelection, onClick: () => promptChmod(side, selected) },
    { separator: true },
    { label: '新建目录', onClick: () => promptMakeDirectory(side) },
    { label: '刷新', onClick: () => void paneRefresh(side) }
  )
  useUi.getState().showMenu(x, y, items)
}
