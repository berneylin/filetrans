import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openPath: async () => '' } }))

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'filetrans-rename-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('本地重命名', () => {
  it('正常重命名返回新路径', async () => {
    const { renameEntry } = await import('../src/main/local/fs')
    const source = path.join(root, 'a.txt')
    writeFileSync(source, '内容')
    const dest = await renameEntry(source, 'b.txt')
    expect(dest).toBe(path.join(root, 'b.txt'))
    expect(readFileSync(dest, 'utf8')).toBe('内容')
    expect(() => readFileSync(source)).toThrow()
  })

  it('目标已存在同名文件时报错且双方保持原状', async () => {
    const { renameEntry } = await import('../src/main/local/fs')
    const source = path.join(root, 'a.txt')
    const dest = path.join(root, 'notes.txt')
    writeFileSync(source, '新内容')
    writeFileSync(dest, '旧内容')
    await expect(renameEntry(source, 'notes.txt')).rejects.toThrow('已存在同名文件或目录')
    expect(readFileSync(source, 'utf8')).toBe('新内容')
    expect(readFileSync(dest, 'utf8')).toBe('旧内容')
  })

  it('目标为已存在目录时同样报错', async () => {
    const { renameEntry } = await import('../src/main/local/fs')
    const source = path.join(root, 'a.txt')
    const dest = path.join(root, 'dir')
    writeFileSync(source, '内容')
    mkdirSync(dest)
    await expect(renameEntry(source, 'dir')).rejects.toThrow('已存在同名文件或目录')
    expect(readFileSync(source, 'utf8')).toBe('内容')
  })

  it('仅大小写不同的重命名在大小写敏感文件系统上放行', async () => {
    const { renameEntry } = await import('../src/main/local/fs')
    const source = path.join(root, 'a.txt')
    writeFileSync(source, '内容')
    const dest = await renameEntry(source, 'A.txt')
    expect(dest.endsWith('A.txt')).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('内容')
  })
})
