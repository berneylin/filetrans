import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: string[] = []
const revealed: string[] = []
const shellResult = vi.hoisted(() => ({ failure: '', hang: false }))

vi.mock('electron', () => ({
  shell: {
    openPath: (target: string): Promise<string> => {
      opened.push(target)
      if (shellResult.hang) return new Promise<string>(() => undefined)
      return Promise.resolve(shellResult.failure)
    },
    showItemInFolder: (target: string): void => {
      revealed.push(target)
    }
  }
}))

let root = ''

beforeEach(() => {
  opened.length = 0
  revealed.length = 0
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
      expect(opened).toEqual([path.join(process.cwd(), 'sub')])
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
    const dir = path.join(root, 'dir')
    mkdirSync(dir)
    shellResult.failure = '没有可用的文件浏览器'
    await expect(openInFileBrowser(dir)).rejects.toThrow('无法在文件浏览器中打开')
    expect(opened).toEqual([dir])
  })

  it('目标不是目录时拒绝打开且不调用 shell', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const file = path.join(root, 'run.sh')
    writeFileSync(file, 'echo hi')
    await expect(openInFileBrowser(file)).rejects.toThrow('只能在文件浏览器中打开目录')
    expect(opened).toEqual([])
    expect(revealed).toEqual([])
  })

  it('macOS 上带扩展名的目录（可能是程序包）只在 Finder 中定位，不直接打开', async () => {
    const { openInFileBrowser } = await import('../src/main/local/fs')
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const bundle = path.join(root, 'Evil.prefPane')
      const hidden = path.join(root, '.config')
      mkdirSync(bundle)
      mkdirSync(hidden)
      await openInFileBrowser(bundle)
      await openInFileBrowser(hidden)
      expect(revealed).toEqual([bundle])
      expect(opened).toEqual([hidden])
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
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
