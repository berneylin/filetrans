import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceWithRollback } from '../src/main/replace'
import { SftpSession } from '../src/main/sftp/session'

describe('本地文件安全替换', () => {
  let dir = ''
  let source = ''
  let target = ''

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-replace-'))
    source = path.join(dir, 'new.part')
    target = path.join(dir, 'target')
    await fs.writeFile(source, '新内容')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'old'), '旧内容')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const operations = () => ({
    rename: (from: string, to: string) => fs.rename(from, to),
    exists: async (file: string) => Boolean(await fs.lstat(file).catch(() => null)),
    remove: (file: string) => fs.rm(file, { recursive: true, force: true })
  })

  it('完成后替换旧目录并清理备份', async () => {
    await replaceWithRollback(source, target, operations())
    expect(await fs.readFile(target, 'utf8')).toBe('新内容')
    expect(await fs.readdir(dir)).toEqual(['target'])
  })

  it('最终重命名失败时恢复旧目录并保留临时文件', async () => {
    const ops = operations()
    ops.rename = async (from, to) => {
      if (from === source) throw new Error('模拟落盘失败')
      await fs.rename(from, to)
    }
    await expect(replaceWithRollback(source, target, ops)).rejects.toThrow('模拟落盘失败')
    expect(await fs.readFile(path.join(target, 'old'), 'utf8')).toBe('旧内容')
    expect(await fs.readFile(source, 'utf8')).toBe('新内容')
    expect((await fs.readdir(dir)).sort()).toEqual(['new.part', 'target'])
  })

  it('回滚也失败时保留备份并报告恢复路径', async () => {
    const ops = operations()
    ops.rename = async (from, to) => {
      if (from !== target) throw new Error('模拟落盘失败')
      await fs.rename(from, to)
    }
    await expect(replaceWithRollback(source, target, ops)).rejects.toThrow('原内容保存在:')
    const backup = (await fs.readdir(dir)).find((name) => name.startsWith('target.filetrans-backup-'))
    expect(backup).toBeDefined()
    expect(await fs.readFile(path.join(dir, backup!, 'old'), 'utf8')).toBe('旧内容')
    expect(await fs.readFile(source, 'utf8')).toBe('新内容')
  })
})

describe('SFTP 文件安全替换', () => {
  function harness(atomic: boolean, failCommit = false) {
    const files = new Map([['/part', '新内容'], ['/target', '旧内容']])
    const rename = vi.fn((from: string, to: string, cb: (err?: Error) => void) => {
      if (files.has(to) || (from === '/part' && failCommit)) {
        cb(new Error('模拟重命名失败'))
        return
      }
      const data = files.get(from)
      if (data === undefined) {
        cb(new Error('源文件不存在'))
        return
      }
      files.set(to, data)
      files.delete(from)
      cb()
    })
    const channel = {
      rename,
      ext_openssh_rename: vi.fn((from: string, to: string, cb: (err?: Error) => void) => {
        if (!atomic) return cb(new Error('不支持原子重命名'))
        files.set(to, files.get(from)!)
        files.delete(from)
        cb()
      })
    }
    const session = new SftpSession(
      { host: 'test', port: 22, username: 'test' },
      async () => ({ accept: true, remember: false })
    )
    Object.assign(session, { sftp: channel })
    vi.spyOn(session, 'lexists').mockImplementation(async (file) => files.has(file))
    const remove = vi.spyOn(session, 'removeEntries').mockImplementation(async (targets) => {
      for (const target of targets) files.delete(target)
    })
    return { session, files, rename, remove }
  }

  it('支持原子重命名时直接替换且不删除旧目标', async () => {
    const { session, files, rename, remove } = harness(true)
    await session.finalizeTransfer('/part', '/target')
    expect([...files]).toEqual([['/target', '新内容']])
    expect(rename).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('不支持原子替换时先备份旧文件，完成后清理备份', async () => {
    const { session, files, remove } = harness(false)
    await session.finalizeTransfer('/part', '/target')
    expect([...files]).toEqual([['/target', '新内容']])
    expect(remove).toHaveBeenCalledWith([expect.stringContaining('/target.filetrans-backup-')])
    expect(remove).not.toHaveBeenCalledWith(['/target'])
  })

  it('不支持原子替换且提交失败时恢复旧文件', async () => {
    const { session, files, remove } = harness(false, true)
    await expect(session.finalizeTransfer('/part', '/target')).rejects.toThrow('模拟重命名失败')
    expect(files.get('/target')).toBe('旧内容')
    expect(files.get('/part')).toBe('新内容')
    expect(files.size).toBe(2)
    expect(remove).not.toHaveBeenCalled()
  })
})
