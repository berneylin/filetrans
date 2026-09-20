import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodEntry, removeEntries } from '../src/main/local/fs'

let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'filetrans-validate-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('removeEntries 入参校验', () => {
  it('传入字符串时拒绝而不是按字符逐个删除', async () => {
    writeFileSync(path.join(root, 'a'), 'keep')
    await expect(removeEntries('a' as unknown as string[])).rejects.toThrow('无效的文件列表')
    expect(await import('node:fs').then((fs) => fs.existsSync(path.join(root, 'a')))).toBe(true)
  })

  it('数组中含非字符串或空串时拒绝', async () => {
    await expect(removeEntries([null as unknown as string])).rejects.toThrow('无效的文件列表')
    await expect(removeEntries([''])).rejects.toThrow('无效的文件列表')
    await expect(removeEntries(['   '])).rejects.toThrow('无效的文件列表')
    await expect(removeEntries(undefined as unknown as string[])).rejects.toThrow('无效的文件列表')
  })

  it('合法数组正常删除', async () => {
    const a = path.join(root, 'a.txt')
    const b = path.join(root, 'b.txt')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    await removeEntries([a, b])
    const fs = await import('node:fs')
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
  })
})

describe('chmodEntry 权限值校验', () => {
  it('拒绝超出 0..0o7777 的权限位', async () => {
    const file = path.join(root, 'chmod-me')
    writeFileSync(file, 'x')
    await expect(chmodEntry(file, 0o100000)).rejects.toThrow('无效的权限值')
    await expect(chmodEntry(file, -1)).rejects.toThrow('无效的权限值')
    await expect(chmodEntry(file, 0o4755)).resolves.toBeUndefined()
  })
})
