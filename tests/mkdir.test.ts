import { promises as fs, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDir, validateName } from '../src/main/local/fs'
import { SftpSession } from '../src/main/sftp/session'

function makeRemoteDirectory(parent: string, input: string): Promise<string> {
  const session = new SftpSession(
    { host: 'test', port: 22, username: 'test' },
    async () => ({ accept: true, remember: false })
  )
  Object.assign(session, {
    sftp: {
      mkdir: (target: string, callback: (error?: unknown) => void) => {
        void fs.mkdir(target).then(() => callback(), callback)
      },
      stat: (target: string, callback: (error: unknown, stats?: Stats) => void) => {
        void fs.stat(target).then((stats) => callback(null, stats), callback)
      }
    }
  })
  return session.makeDir(parent, input)
}

describe.each([
  { name: '本地', mkdir: makeDir },
  { name: '远程', mkdir: makeRemoteDirectory }
])('$name 递归新建目录', ({ mkdir }) => {
  let root = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-mkdir-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('一次创建多级目录，重复创建也成功', async () => {
    const target = path.join(root, '项目', '新 目录', '输出')
    expect(await mkdir(root, '项目/新 目录/输出')).toBe(target)
    expect((await fs.stat(target)).isDirectory()).toBe(true)
    await fs.writeFile(path.join(target, 'keep.txt'), '保留内容')
    expect(await mkdir(root, '项目/新 目录/输出')).toBe(target)
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('保留内容')
  })

  it('补齐缺失层级并接受重复及末尾斜杠', async () => {
    await fs.mkdir(path.join(root, 'a'))
    expect(await mkdir(root, ' a//b/c/ ')).toBe(path.join(root, 'a/b/c'))
    expect((await fs.stat(path.join(root, 'a/b/c'))).isDirectory()).toBe(true)
  })

  it('绝对路径不拼接当前目录', async () => {
    const target = path.join(root, 'absolute', 'child')
    expect(await mkdir(path.join(root, 'current'), target)).toBe(target)
    expect((await fs.stat(target)).isDirectory()).toBe(true)
  })

  it.each(['../escaped', '../../escaped'])('拒绝穿越父目录：%s', async (input) => {
    await expect(mkdir(root, input)).rejects.toThrow('无效的目录路径')
    expect(await fs.readdir(root)).toEqual([])
  })

  it.each(['blocked', 'blocked/child'])('路径被普通文件占用时保留文件并报错：%s', async (input) => {
    await fs.writeFile(path.join(root, 'blocked'), '不能覆盖')
    await expect(mkdir(root, input)).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'blocked'), 'utf8')).toBe('不能覆盖')
  })

  it.each(['', '   ', 'a\0b'])('拒绝无效路径：%j', async (input) => {
    await expect(mkdir(root, input)).rejects.toThrow('无效的目录路径')
    expect(await fs.readdir(root)).toEqual([])
  })
})

it('重命名仍然只接受单个名称', () => {
  expect(() => validateName('a/b')).toThrow('无效的名称')
})
