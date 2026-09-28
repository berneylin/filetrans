import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import type { ConnectParams } from '@shared/types'
import { SftpSession } from '../src/main/sftp/session'

interface RawAttrs {
  mode: number
  size: number
  atime: number
  mtime: number
}

interface RawEntry {
  filename: string
  attrs: RawAttrs
}

const attrs = (mode: number, size = 0): RawAttrs => ({
  mode,
  size,
  atime: 1700000000,
  mtime: 1700000000
})

function makeSession(): {
  session: SftpSession
  setEntries: (entries: RawEntry[]) => void
  setRemoteStat: (path: string, attrs: RawAttrs) => void
  writeOptions: () => Record<string, unknown> | undefined
  failWith: (path: string, code: number) => void
  renames: Array<{ from: string; to: string }>
} {
  let entries: RawEntry[] = []
  const remoteStats = new Map<string, RawAttrs>()
  const failures = new Map<string, number>()
  const renames: Array<{ from: string; to: string }> = []
  let captured: { target: string; options?: Record<string, unknown> } | undefined
  const sftpError = (code: number): Error => Object.assign(new Error('Failure'), { code })
  const channel = {
    realpath: (_target: string, cb: (err: unknown, result?: string) => void): void => {
      cb(null, '/home/u')
    },
    lstat: (target: string, cb: (err: unknown, result?: RawAttrs) => void): void => {
      const stats = remoteStats.get(target)
      if (stats) cb(null, stats)
      else cb(sftpError(2))
    },
    rename: (from: string, to: string, cb: (err: unknown) => void): void => {
      const code = failures.get(from)
      if (code) {
        cb(sftpError(code))
        return
      }
      renames.push({ from, to })
      cb(null)
    },
    unlink: (target: string, cb: (err: unknown) => void): void => {
      const code = failures.get(target)
      cb(code ? sftpError(code) : null)
    },
    readdir: (_target: string, cb: (err: unknown, result?: RawEntry[]) => void): void => {
      cb(null, entries)
    },
    stat: (target: string, cb: (err: unknown, result?: RawAttrs) => void): void => {
      const stats = remoteStats.get(target)
      if (stats) cb(null, stats)
      else cb(new Error('No such file'))
    },
    createWriteStream: (
      target: string,
      options?: Record<string, unknown>
    ): NodeJS.WritableStream => {
      captured = { target, options }
      return new PassThrough() as unknown as NodeJS.WritableStream
    }
  }
  const session = new SftpSession(
    { host: 'h', port: 22, username: 'u' } as ConnectParams,
    async () => ({ accept: false, remember: false })
  )
  ;(session as unknown as { sftp: unknown }).sftp = channel
  return {
    session,
    setEntries: (next) => {
      entries = next
    },
    setRemoteStat: (path, next) => {
      remoteStats.set(path, next)
    },
    writeOptions: () => captured?.options,
    failWith: (path, code) => {
      failures.set(path, code)
    },
    renames
  }
}

describe('SftpSession.list 净化', () => {
  it('丢弃空名、点路径与含斜杠的非法文件名', async () => {
    const { session, setEntries } = makeSession()
    setEntries([
      { filename: 'ok.txt', attrs: attrs(0o100640, 3) },
      { filename: '.', attrs: attrs(0o040755) },
      { filename: '..', attrs: attrs(0o040755) },
      { filename: '', attrs: attrs(0o100640) },
      { filename: '../escape', attrs: attrs(0o100640) },
      { filename: 'sub/name', attrs: attrs(0o100640) }
    ])
    const listing = await session.list('/')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['ok.txt'])
  })

  it('同一目录出现重名时整体报错', async () => {
    const { session, setEntries } = makeSession()
    setEntries([
      { filename: 'same', attrs: attrs(0o120777) },
      { filename: 'same', attrs: attrs(0o100640) }
    ])
    await expect(session.list('/')).rejects.toThrow('重复的文件名')
  })

  it('指向目录的符号链接解析为目标类型且保留链接标记', async () => {
    const { session, setEntries, setRemoteStat } = makeSession()
    setEntries([{ filename: 'd', attrs: attrs(0o120777) }])
    setRemoteStat('/d', attrs(0o040755))
    const listing = await session.list('/')
    expect(listing.entries[0].type).toBe('directory')
    expect(listing.entries[0].isSymlink).toBe(true)
  })

  it('指向文件的符号链接解析为 file 类型', async () => {
    const { session, setEntries, setRemoteStat } = makeSession()
    setEntries([{ filename: 'l', attrs: attrs(0o120777) }])
    setRemoteStat('/l', attrs(0o100640, 12))
    const listing = await session.list('/')
    expect(listing.entries[0].type).toBe('file')
    expect(listing.entries[0].isSymlink).toBe(true)
  })

  it('悬空链接保留 symlink 类型', async () => {
    const { session, setEntries } = makeSession()
    setEntries([{ filename: 'dangling', attrs: attrs(0o120777) }])
    const listing = await session.list('/')
    expect(listing.entries[0].type).toBe('symlink')
    expect(listing.entries[0].isSymlink).toBe(true)
  })
})

describe('SftpSession.createWriteStream', () => {
  it('写流固定以 0600 权限创建', async () => {
    const { session, writeOptions } = makeSession()
    session.createWriteStream('/remote/file.bin', 'w')
    expect(writeOptions()).toEqual({ flags: 'w', mode: 0o600 })
    session.createWriteStream('/remote/file.bin', 'a')
    expect(writeOptions()).toEqual({ flags: 'a', mode: 0o600 })
  })
})

describe('SftpSession 错误与路径处理', () => {
  it('SFTP 错误翻译为中文并带上出错路径', async () => {
    const { session, setRemoteStat, failWith } = makeSession()
    setRemoteStat('/remote/locked.txt', attrs(0o100644, 1))
    failWith('/remote/locked.txt', 3)
    await expect(session.removeEntries(['/remote/locked.txt'])).rejects.toThrow(
      '权限不足: /remote/locked.txt'
    )
    await expect(session.lstat('/remote/missing')).rejects.toThrow('路径不存在: /remote/missing')
  })

  it('重命名目标已存在时报错且不发起重命名', async () => {
    const { session, setRemoteStat, renames } = makeSession()
    setRemoteStat('/remote/a.txt', attrs(0o100644, 1))
    setRemoteStat('/remote/b.txt', attrs(0o100644, 1))
    await expect(session.renameEntry('/remote/a.txt', 'b.txt')).rejects.toThrow(
      '已存在同名文件或目录: /remote/b.txt'
    )
    expect(renames).toEqual([])
  })

  it('仅大小写不同的重命名与正常重命名照常发起', async () => {
    const { session, setRemoteStat, renames } = makeSession()
    setRemoteStat('/remote/a.txt', attrs(0o100644, 1))
    await expect(session.renameEntry('/remote/a.txt', 'A.txt')).resolves.toBe('/remote/A.txt')
    await expect(session.renameEntry('/remote/a.txt', 'c.txt')).resolves.toBe('/remote/c.txt')
    expect(renames).toEqual([
      { from: '/remote/a.txt', to: '/remote/A.txt' },
      { from: '/remote/a.txt', to: '/remote/c.txt' }
    ])
  })

  it('~ 与 ~/ 展开为主目录，其余 ~ 开头的路径按主目录下的相对路径处理', async () => {
    const { session } = makeSession()
    await expect(session.resolvePath('~')).resolves.toBe('/home/u')
    await expect(session.resolvePath('~/data')).resolves.toBe('/home/u/data')
    await expect(session.resolvePath('~bob/x')).resolves.toBe('/home/u/~bob/x')
  })
})

describe('SftpSession.connect', () => {
  it('加密私钥未提供口令时返回中文错误', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-enc-key-'))
    try {
      const keyFile = path.join(dir, 'id_ed25519')
      const { private: privateKey } = utils.generateKeyPairSync('ed25519', {
        passphrase: 'secret',
        cipher: 'aes256-ctr',
        rounds: 4
      })
      await fs.writeFile(keyFile, privateKey, { mode: 0o600 })
      const session = new SftpSession(
        { host: '127.0.0.1', port: 9, username: 'u', privateKeyPath: keyFile } as ConnectParams,
        async () => ({ accept: false, remember: false })
      )
      await expect(session.connect()).rejects.toThrow('私钥已加密，请填写正确的密钥口令')
      await session.close()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
