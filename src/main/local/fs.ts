import { promises as fs, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { DirListing, EntryType, FileEntry } from '@shared/types'
import { validateDirectoryPath, escapesParent, isTransientFile } from '@shared/path'
import { assertPermissionMode } from '@shared/format'

function friendlyError(err: unknown, target: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code
  const messages: Record<string, string> = {
    EACCES: `权限不足: ${target}`,
    EPERM: `操作不被允许: ${target}`,
    ENOENT: `路径不存在: ${target}`,
    ENOTDIR: `不是目录: ${target}`,
    EEXIST: `已存在同名文件或目录: ${target}`,
    ENOTEMPTY: `目录不为空: ${target}`,
    EBUSY: `文件被占用: ${target}`,
    ENAMETOOLONG: `文件名过长: ${target}`,
    EROFS: `只读文件系统: ${target}`
  }
  if (code && messages[code]) return new Error(messages[code])
  return err instanceof Error ? err : new Error(String(err))
}

function assertSafeTarget(target: string): void {
  const resolved = path.resolve(target)
  if (resolved === path.parse(resolved).root) {
    throw new Error('拒绝操作根目录')
  }
}

export function validateName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
    throw new Error('无效的名称')
  }
  return trimmed
}

function toEntry(
  fullPath: string,
  name: string,
  stats: Stats,
  type: EntryType,
  modeOverride?: number
): FileEntry {
  return {
    name,
    path: fullPath,
    type,
    size: stats.size,
    mtime: stats.mtimeMs,
    atime: stats.atimeMs,
    mode: modeOverride ?? stats.mode,
    isSymlink: stats.isSymbolicLink()
  }
}

export function localHome(): string {
  return homedir()
}

export async function listLocal(dirPath: string): Promise<DirListing> {
  const trimmed = dirPath.trim()
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(homedir(), trimmed === '~' ? '' : trimmed.slice(2))
      : trimmed
  if (!path.isAbsolute(expanded)) {
    throw new Error('本地目录必须是绝对路径')
  }
  const resolved = path.resolve(expanded)
  let dirents
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true })
  } catch (err) {
    throw friendlyError(err, resolved)
  }
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry | null> => {
      const full = path.join(resolved, dirent.name)
      try {
        const lstats = await fs.lstat(full)
        let type: EntryType = dirent.isDirectory()
          ? 'directory'
          : dirent.isFile()
            ? 'file'
            : dirent.isSymbolicLink()
              ? 'symlink'
              : 'other'
        let modeOverride: number | undefined
        if (dirent.isSymbolicLink()) {
          try {
            const target = await fs.stat(full)
            type = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'symlink'
            modeOverride = target.mode
          } catch {
            type = 'symlink'
          }
        }
        return toEntry(full, dirent.name, lstats, type, modeOverride)
      } catch {
        return null
      }
    })
  )
  return {
    path: resolved,
    parent: path.dirname(resolved) === resolved ? null : path.dirname(resolved),
    entries: entries.filter(
      (e): e is FileEntry => e !== null && !isTransientFile(e.name)
    )
  }
}

export async function cleanTransientFiles(dirPath: string): Promise<number> {
  const resolved = path.resolve(dirPath)
  let dirents
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true })
  } catch (err) {
    throw friendlyError(err, resolved)
  }
  let removed = 0
  for (const dirent of dirents) {
    if (dirent.isDirectory() || !isTransientFile(dirent.name)) continue
    try {
      await fs.rm(path.join(resolved, dirent.name), { force: true })
      removed++
    } catch {
      /* 单个清理失败不阻断 */
    }
  }
  return removed
}

export async function makeDir(parent: string, name: string): Promise<string> {
  const requested = validateDirectoryPath(name)
  if (escapesParent(parent, requested)) throw new Error('无效的目录路径')
  const target = path.resolve(parent, requested)
  try {
    await fs.mkdir(target, { recursive: true })
  } catch (err) {
    throw friendlyError(err, target)
  }
  return target
}

export async function renameEntry(target: string, newName: string): Promise<string> {
  assertSafeTarget(target)
  const dest = path.join(path.dirname(target), validateName(newName))
  let sourceStats: Stats
  try {
    sourceStats = await fs.lstat(target)
  } catch (err) {
    throw friendlyError(err, target)
  }
  const destStats = await fs.lstat(dest).catch(() => null)
  if (destStats && !(destStats.dev === sourceStats.dev && destStats.ino === sourceStats.ino)) {
    throw new Error(`已存在同名文件或目录: ${dest}`)
  }
  try {
    await fs.rename(target, dest)
  } catch (err) {
    throw friendlyError(err, dest)
  }
  return dest
}

function assertPathList(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('无效的文件列表')
  }
}

export async function removeEntries(paths: string[]): Promise<void> {
  assertPathList(paths)
  for (const target of paths) {
    assertSafeTarget(target)
    try {
      await fs.rm(target, { recursive: true, force: true })
    } catch (err) {
      throw friendlyError(err, target)
    }
  }
}

export async function chmodEntry(target: string, mode: number): Promise<void> {
  assertPermissionMode(mode)
  try {
    await fs.chmod(target, mode)
  } catch (err) {
    throw friendlyError(err, target)
  }
}

const OPEN_BROWSER_TIMEOUT_MS = 5000

export async function openInFileBrowser(target: string): Promise<void> {
  const resolved = path.resolve(target)
  let stats: Stats
  try {
    stats = await fs.stat(resolved)
  } catch (err) {
    throw friendlyError(err, resolved)
  }
  if (!stats.isDirectory()) {
    throw new Error(`只能在文件浏览器中打开目录: ${resolved}`)
  }
  if (process.platform === 'darwin' && /.\.[^.]+$/.test(path.basename(resolved))) {
    shell.showItemInFolder(resolved)
    return
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const outcome = await Promise.race([
      shell.openPath(resolved),
      new Promise<'launched'>((resolve) => {
        timer = setTimeout(() => resolve('launched'), OPEN_BROWSER_TIMEOUT_MS)
      })
    ])
    if (outcome !== 'launched' && outcome) {
      throw new Error(`无法在文件浏览器中打开: ${outcome}`)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
