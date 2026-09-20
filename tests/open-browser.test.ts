import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: string[] = []
const shellResult = vi.hoisted(() => ({ failure: '', hang: false }))

vi.mock('electron', () => ({
  shell: {
    openPath: (target: string): Promise<string> => {
      opened.push(target)
      if (shellResult.hang) return new Promise<string>(() => undefined)
      return Promise.resolve(shellResult.failure)
    }
  }
}))

let root = ''

beforeEach(() => {
  opened.length = 0
  shellResult.failure = ''
  root = mkdtempSync(path.join(os.tmpdir(), 'filetrans-open-browser-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('openInFileBrowser', () => {
  it('用系统文件浏览器打开本地目录', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const dir = path.join(root, '项目')
    mkdirSync(dir)
    await openInFileBrowser(dir)
    expect(opened).toEqual([dir])
  })

  it('相对路径解析为绝对路径', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const cwd = process.cwd()
    const dir = path.join(root, 'sub')
    mkdirSync(dir)
    process.chdir(root)
    try {
      await openInFileBrowser('sub')
      expect(opened).toEqual([dir])
    } finally {
      process.chdir(cwd)
    }
  })

  it('目标不存在时报友好错误且不调用 shell', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const missing = path.join(root, 'missing')
    await expect(openInFileBrowser(missing)).rejects.toThrow('路径不存在')
    expect(opened).toEqual([])
  })

  it('文件浏览器打开失败时抛出原因', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const file = path.join(root, 'a.txt')
    writeFileSync(file, 'x')
    shellResult.failure = '没有可用的文件浏览器'
    await expect(openInFileBrowser(file)).rejects.toThrow('无法在文件浏览器中打开')
    expect(opened).toEqual([file])
  })

  it('openPath 永不返回时不会挂死，按已启动处理', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const dir = path.join(root, 'hang')
    mkdirSync(dir)
    shellResult.hang = true
    try {
      await expect(openInFileBrowser(dir)).resolves.toBeUndefined()
      expect(opened).toEqual([dir])
    } finally {
      shellResult.hang = false
    }
  }, 15000)
})
