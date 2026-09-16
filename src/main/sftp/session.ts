import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Client, utils, type SFTPWrapper, type Stats } from 'ssh2'
import type { ConnectParams, DirListing, EntryType, FileEntry, HostKeyInfo, KeyCheckResult } from '@shared/types'
import { typeFromMode } from '@shared/format'
import { posixDirname, posixJoin, posixNormalize, posixParent } from '@shared/path'
import { validateName } from '../local/fs'

export type HostKeyResolver = (
  info: HostKeyInfo
) => Promise<{ accept: boolean; remember: boolean }>

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return posixJoin(homedir(), input.slice(2))
  return input
}

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export async function checkPrivateKey(
  file: string,
  passphrase?: string
): Promise<KeyCheckResult> {
  let key: Buffer
  try {
    key = await readFile(expandHome(file))
  } catch {
    return { valid: false, message: `无法读取私钥文件: ${file}` }
  }
  const parsed = utils.parseKey(key, passphrase || undefined)
  if (parsed instanceof Error) {
    const message = parsed.message
    if (/passphrase|encrypted/i.test(message)) {
      if (passphrase) {
        return { valid: false, message: `私钥口令错误或无法解密: ${message}` }
      }
      return { valid: true, message: '私钥已加密，连接时需要提供口令' }
    }
    return {
      valid: false,
      message: `私钥文件格式无效: ${file}（请确认选择的是私钥文件，而非公钥等其他文件）`
    }
  }
  if (!parsed.isPrivateKey()) {
    return { valid: false, message: `这是公钥文件: ${file}（请选择对应的私钥文件）` }
  }
  return { valid: true }
}

interface RawDirEntry {
  filename: string
  attrs: Stats
}

export class SftpSession extends EventEmitter {
  readonly id: string
  readonly params: ConnectParams
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private closed = false
  private homePath: string | null = null
  private hostKeyBlob: Buffer | null = null

  constructor(
    params: ConnectParams,
    private resolveHostKey: HostKeyResolver,
    id: string = randomUUID()
  ) {
    super()
    this.params = params
    this.id = id
  }

  get hostKey(): Buffer | null {
    return this.hostKeyBlob
  }

  async connect(): Promise<void> {
    const { host, port, username, password, privateKeyPath, passphrase } = this.params
    let privateKey: Buffer | undefined
    if (privateKeyPath) {
      const check = await checkPrivateKey(privateKeyPath, passphrase)
      if (!check.valid) {
        throw new Error(check.message ?? `私钥文件格式无效: ${privateKeyPath}`)
      }
      privateKey = await readFile(expandHome(privateKeyPath))
    }
    const client = new Client()
    this.client = client
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (!settled) {
          settled = true
          reject(err)
        }
      }
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) {
            fail(new Error(`SFTP 子系统启动失败: ${err.message}`))
            return
          }
          this.sftp = sftp
          settled = true
          resolve()
        })
      })
      client.on('error', (err: Error) => {
        this.emit('session-error', err)
        fail(err)
      })
      client.on('close', () => {
        const wasClosed = this.closed
        this.closed = true
        this.sftp = null
        if (!wasClosed) this.emit('close')
      })
      client.connect({
        host,
        port,
        username,
        password: password || undefined,
        privateKey,
        passphrase: passphrase || undefined,
        tryKeyboard: true,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        readyTimeout: 120000,
        hostVerifier: ((key: Buffer, callback: (ok: boolean) => void) => {
          this.hostKeyBlob = key
          this.resolveHostKey({ host, port, fingerprint: fingerprintOf(key), known: 'unknown' })
            .then(({ accept }) => callback(accept))
            .catch(() => callback(false))
        }) as never
      })
      client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        finish([password ?? passphrase ?? ''])
      })
    })
  }

  get connected(): boolean {
    return Boolean(this.sftp) && !this.closed
  }

  private get channel(): SFTPWrapper {
    if (!this.sftp || this.closed) throw new Error('SFTP 会话未连接')
    return this.sftp
  }

  private call<T>(
    fn: (cb: (err: Error | undefined | null, result?: T) => void) => void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      fn((err, result) => (err ? reject(err) : resolve(result as T)))
    })
  }

  async home(): Promise<string> {
    if (this.homePath) return this.homePath
    const resolved = await this.call<string>((cb) => this.channel.realpath('.', cb))
    this.homePath = resolved
    return resolved
  }

  async resolvePath(input: string): Promise<string> {
    if (!input) return this.home()
    if (input.startsWith('~')) {
      const home = await this.home()
      return posixJoin(home, input.slice(1))
    }
    if (!input.startsWith('/')) {
      const home = await this.home()
      return posixJoin(home, input)
    }
    return posixNormalize(input)
  }

  async list(dirPath: string): Promise<DirListing> {
    const resolved = await this.resolvePath(dirPath)
    let raw: RawDirEntry[]
    try {
      raw = await this.call((cb) => this.channel.readdir(resolved, cb))
    } catch (err) {
      throw new Error(`无法读取目录 ${resolved}: ${(err as Error).message}`)
    }
    const entries: FileEntry[] = raw
      .filter((item) => item.filename !== '.' && item.filename !== '..')
      .map((item) => {
        const type = typeFromMode(item.attrs.mode) as EntryType
        return {
          name: item.filename,
          path: posixJoin(resolved, item.filename),
          type,
          size: item.attrs.size,
          mtime: item.attrs.mtime * 1000,
          atime: item.attrs.atime * 1000,
          mode: item.attrs.mode,
          isSymlink: type === 'symlink'
        }
      })
    return { path: resolved, parent: posixParent(resolved), entries }
  }

  async stat(target: string): Promise<Stats> {
    return this.call((cb) => this.channel.stat(target, cb))
  }

  async lstat(target: string): Promise<Stats> {
    return this.call((cb) => this.channel.lstat(target, cb))
  }

  async realpath(target: string): Promise<string> {
    return this.call((cb) => this.channel.realpath(target, cb))
  }

  exec(command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const client = this.client
    if (!client || this.closed) return Promise.reject(new Error('SFTP 会话未连接'))
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('error', reject)
        stream.on('close', (code: number | null) => {
          resolve({ stdout, stderr, code })
        })
      })
    })
  }

  async readlink(target: string): Promise<string> {
    return this.call((cb) => this.channel.readlink(target, cb))
  }

  async symlink(targetPath: string, linkPath: string): Promise<void> {
    await this.call((cb) => this.channel.symlink(targetPath, linkPath, cb))
  }

  async finalizeTransfer(fromPath: string, toPath: string): Promise<void> {
    try {
      await this.call((cb) => this.channel.ext_openssh_rename(fromPath, toPath, cb))
      return
    } catch {
      /* 不支持 posix-rename，回退常规 rename */
    }
    try {
      await this.call((cb) => this.channel.rename(fromPath, toPath, cb))
      return
    } catch {
      /* 目标已存在等原因，回退删除后重命名 */
    }
    if (await this.lexists(toPath)) await this.removeEntries([toPath])
    await this.call((cb) => this.channel.rename(fromPath, toPath, cb))
  }

  async exists(target: string): Promise<boolean> {
    try {
      await this.stat(target)
      return true
    } catch {
      return false
    }
  }

  async lexists(target: string): Promise<boolean> {
    try {
      await this.lstat(target)
      return true
    } catch {
      return false
    }
  }

  async makeDir(parent: string, name: string): Promise<string> {
    const target = posixJoin(parent, validateName(name))
    await this.call((cb) => this.channel.mkdir(target, cb))
    return target
  }

  async mkdirp(target: string): Promise<void> {
    const normalized = posixNormalize(target)
    if (normalized === '/' || normalized === '.') return
    const absolute = normalized.startsWith('/')
    const parts = normalized.split('/').filter(Boolean)
    let current = absolute ? '/' : ''
    for (const part of parts) {
      current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part
      try {
        await this.call((cb) => this.channel.mkdir(current, cb))
      } catch (err) {
        const stats = await this.stat(current).catch(() => null)
        if (!stats || typeFromMode(stats.mode) !== 'directory') {
          throw new Error(`无法创建目录 ${current}: ${(err as Error).message}`)
        }
      }
    }
  }

  async renameEntry(target: string, newName: string): Promise<string> {
    const dest = posixJoin(posixDirname(target), validateName(newName))
    await this.call((cb) => this.channel.rename(target, dest, cb))
    return dest
  }

  async removeEntries(paths: string[]): Promise<void> {
    for (const target of paths) {
      if (posixNormalize(target) === '/') throw new Error('拒绝删除根目录')
      await this.removeEntry(target)
    }
  }

  private async removeEntry(target: string): Promise<void> {
    const stats = await this.lstat(target)
    const type = typeFromMode(stats.mode)
    if (type === 'directory') {
      const children = await this.call<RawDirEntry[]>((cb) => this.channel.readdir(target, cb))
      for (const child of children) {
        if (child.filename === '.' || child.filename === '..') continue
        await this.removeEntry(posixJoin(target, child.filename))
      }
      await this.call((cb) => this.channel.rmdir(target, cb))
    } else {
      await this.call((cb) => this.channel.unlink(target, cb))
    }
  }

  async chmodEntry(target: string, mode: number): Promise<void> {
    await this.call((cb) => this.channel.chmod(target, mode, cb))
  }

  async utimes(target: string, atime: number, mtime: number): Promise<void> {
    await this.call((cb) => this.channel.utimes(target, atime, mtime, cb))
  }

  createReadStream(
    target: string,
    options?: { start?: number; end?: number; highWaterMark?: number }
  ): NodeJS.ReadableStream & { destroy: (err?: Error) => void } {
    return this.channel.createReadStream(target, options) as NodeJS.ReadableStream & {
      destroy: (err?: Error) => void
    }
  }

  createWriteStream(
    target: string,
    flags: 'w' | 'a' = 'w'
  ): NodeJS.WritableStream & { destroy: (err?: Error) => void } {
    return this.channel.createWriteStream(target, { flags }) as NodeJS.WritableStream & {
      destroy: (err?: Error) => void
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.sftp = null
    if (this.client) {
      this.client.end()
      this.client = null
    }
  }
}
