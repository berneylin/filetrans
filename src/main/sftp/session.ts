import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Client, utils, type SFTPWrapper, type Stats } from 'ssh2'
import type { ConnectParams, DirListing, EntryType, FileEntry, HostKeyInfo, KeyCheckResult } from '@shared/types'
import { typeFromMode, assertPermissionMode } from '@shared/format'
import { posixDirname, posixJoin, posixNormalize, posixParent, validateDirectoryPath, escapesParent, isTransientFile } from '@shared/path'
import { validateName } from '../local/fs'
import { replaceWithRollback } from '../replace'

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

export function translateConnectError(err: Error): Error {
  const message = err.message ?? ''
  if (/Encrypted private key detected|passphrase/i.test(message) && /private|key/i.test(message)) {
    return new Error('私钥已加密，请填写正确的密钥口令', { cause: err })
  }
  if (/All authentication methods have failed|Authentication failed/i.test(message)) {
    return new Error('认证失败：请检查用户名、密码或密钥配置', { cause: err })
  }
  if (/keepalive|timed? out|timeout/i.test(message)) {
    return new Error('连接超时：服务器无响应', { cause: err })
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new Error('连接被拒绝：请检查主机地址和端口', { cause: err })
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return new Error('无法解析主机名：请检查主机地址', { cause: err })
  }
  return err
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

function translateSftpError(err: unknown, target?: string): Error {
  const code = (err as { code?: number } | null)?.code
  const suffix = target ? `: ${target}` : ''
  if (code === 2) return new Error(`路径不存在${suffix}`)
  if (code === 3) return new Error(`权限不足${suffix}`)
  if (code === 4) return new Error(`SFTP 操作失败${suffix}`)
  return err instanceof Error ? err : new Error(String(err))
}

export class SftpSession extends EventEmitter {
  readonly id: string
  readonly params: ConnectParams
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private closed = false
  private homePath: string | null = null
  private hostKeyBlob: Buffer | null = null
  private acceptedHostKey: Buffer | null = null

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

  private handleChannelLost(): void {
    if (this.closed) return
    this.closed = true
    this.sftp = null
    const client = this.client
    this.client = null
    try {
      client?.end()
    } catch {
      /* 客户端已销毁 */
    }
    this.emit('close')
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
          sftp.on('error', () => this.handleChannelLost())
          sftp.on('close', () => this.handleChannelLost())
          sftp.on('end', () => this.handleChannelLost())
          settled = true
          resolve()
        })
      })
      client.on('error', (err: Error) => {
        this.emit('session-error', err)
        fail(translateConnectError(err))
      })
      client.on('close', () => {
        const wasClosed = this.closed
        this.closed = true
        this.sftp = null
        if (!wasClosed) this.emit('close')
        fail(new Error('连接在认证完成前被服务器关闭'))
      })
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        if (privateKeyPath || !password || prompts.length !== 1 || prompts[0].echo) {
          finish([])
          return
        }
        finish([password])
      })
      try {
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
            if (this.acceptedHostKey) {
              callback(key.equals(this.acceptedHostKey))
              return
            }
            this.resolveHostKey({ host, port, fingerprint: fingerprintOf(key), known: 'unknown' })
              .then(({ accept }) => {
                if (accept) {
                  this.acceptedHostKey = key
                  this.hostKeyBlob = key
                }
                callback(accept)
              })
              .catch(() => callback(false))
          }) as never
        })
      } catch (err) {
        fail(translateConnectError(err instanceof Error ? err : new Error(String(err))))
      }
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
    fn: (cb: (err: Error | undefined | null, result?: T) => void) => void,
    target?: string
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      fn((err, result) => {
        if (err) reject(translateSftpError(err, target))
        else resolve(result as T)
      })
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
    if (input === '~') return this.home()
    if (input.startsWith('~/')) {
      const home = await this.home()
      return posixJoin(home, input.slice(2))
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
    const seen = new Set<string>()
    const entries: FileEntry[] = []
    for (const item of raw) {
      const name = item.filename
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        continue
      }
      if (isTransientFile(name)) continue
      if (seen.has(name)) {
        throw new Error(`服务器在目录 ${resolved} 中返回了重复的文件名 ${name}，已中止以避免写入错误位置`)
      }
      seen.add(name)
      const type = typeFromMode(item.attrs.mode) as EntryType
      entries.push({
        name,
        path: posixJoin(resolved, name),
        type,
        size: item.attrs.size ?? 0,
        mtime: (item.attrs.mtime ?? 0) * 1000,
        atime: (item.attrs.atime ?? 0) * 1000,
        mode: item.attrs.mode ?? 0,
        isSymlink: type === 'symlink'
      })
    }
    const links = entries.filter((entry) => entry.isSymlink)
    let cursor = 0
    const resolveLink = async (): Promise<void> => {
      for (;;) {
        const index = cursor++
        if (index >= links.length) return
        const entry = links[index]
        try {
          const target = await this.stat(entry.path)
          const targetType = typeFromMode(target.mode)
          if (targetType === 'file' || targetType === 'directory') {
            entry.type = targetType
            entry.mode = target.mode
          }
        } catch {
          /* 悬空链接保留 symlink 类型 */
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, links.length) }, () => resolveLink()))
    return { path: resolved, parent: posixParent(resolved), entries }
  }

  async stat(target: string): Promise<Stats> {
    return this.call((cb) => this.channel.stat(target, cb), target)
  }

  async lstat(target: string): Promise<Stats> {
    return this.call((cb) => this.channel.lstat(target, cb), target)
  }

  async realpath(target: string): Promise<string> {
    return this.call((cb) => this.channel.realpath(target, cb), target)
  }

  exec(
    command: string,
    timeoutMs = 30000
  ): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const client = this.client
    if (!client || this.closed) return Promise.reject(new Error('SFTP 会话未连接'))
    return new Promise((resolve, reject) => {
      let settled = false
      const settleReject = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      const settleResolve = (result: { stdout: string; stderr: string; code: number | null }): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      client.exec(command, (err, stream) => {
        if (err) {
          settleReject(err)
          return
        }
        const timer = setTimeout(() => {
          settleReject(new Error(`远程命令执行超时 (${timeoutMs}ms): ${command}`))
          try {
            stream.destroy()
          } catch {
            /* 流已结束 */
          }
        }, timeoutMs)
        const finish = (): void => {
          clearTimeout(timer)
        }
        let stdout = ''
        let stderr = ''
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        stream.on('error', (error: Error) => {
          finish()
          settleReject(error)
        })
        stream.on('close', (code: number | null) => {
          finish()
          settleResolve({ stdout, stderr, code })
        })
      })
    })
  }

  async readlink(target: string): Promise<string> {
    return this.call((cb) => this.channel.readlink(target, cb), target)
  }

  async symlink(targetPath: string, linkPath: string): Promise<void> {
    await this.call((cb) => this.channel.symlink(targetPath, linkPath, cb), linkPath)
  }

  async finalizeTransfer(fromPath: string, toPath: string): Promise<void> {
    const rename = (source: string, target: string): Promise<void> =>
      this.call((cb) => this.channel.rename(source, target, cb), target)
    await replaceWithRollback(fromPath, toPath, {
      rename,
      replace: async (source, target) => {
        try {
          await this.call((cb) => this.channel.ext_openssh_rename(source, target, cb), target)
        } catch {
          await rename(source, target)
        }
      },
      exists: (target) => this.lexists(target),
      remove: (target) => this.removeEntries([target])
    })
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
    const directory = validateDirectoryPath(name)
    if (escapesParent(parent, directory)) throw new Error('无效的目录路径')
    const target = directory.startsWith('/') ? posixNormalize(directory) : posixJoin(parent, directory)
    await this.mkdirp(target)
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
    if (dest.toLowerCase() !== target.toLowerCase() && (await this.lexists(dest))) {
      throw new Error(`已存在同名文件或目录: ${dest}`)
    }
    await this.call((cb) => this.channel.rename(target, dest, cb), target)
    return dest
  }

  async removeEntries(paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error('无效的文件列表')
    }
    for (const target of paths) {
      if (posixNormalize(target) === '/') throw new Error('拒绝删除根目录')
      await this.removeEntry(target)
    }
  }

  private async removeEntry(target: string): Promise<void> {
    const stats = await this.lstat(target)
    const type = typeFromMode(stats.mode)
    if (type === 'directory') {
      const children = await this.call<RawDirEntry[]>(
        (cb) => this.channel.readdir(target, cb),
        target
      )
      for (const child of children) {
        if (child.filename === '.' || child.filename === '..') continue
        await this.removeEntry(posixJoin(target, child.filename))
      }
      await this.call((cb) => this.channel.rmdir(target, cb), target)
    } else {
      await this.call((cb) => this.channel.unlink(target, cb), target)
    }
  }

  async chmodEntry(target: string, mode: number): Promise<void> {
    assertPermissionMode(mode)
    await this.call((cb) => this.channel.chmod(target, mode, cb), target)
  }

  async cleanTransientFiles(target: string): Promise<number> {
    const resolved = await this.resolvePath(target)
    const raw = await this.call<RawDirEntry[]>((cb) => this.channel.readdir(resolved, cb), resolved)
    let removed = 0
    for (const item of raw) {
      if (item.filename === '.' || item.filename === '..') continue
      if (!isTransientFile(item.filename)) continue
      const candidate = posixJoin(resolved, item.filename)
      try {
        const stats = await this.lstat(candidate)
        if (typeFromMode(stats.mode) === 'directory') continue
        await this.call((cb) => this.channel.unlink(candidate, cb))
        removed++
      } catch {
        /* 单个清理失败不阻断 */
      }
    }
    return removed
  }

  async utimes(target: string, atime: number, mtime: number): Promise<void> {
    await this.call((cb) => this.channel.utimes(target, atime, mtime, cb), target)
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
    return this.channel.createWriteStream(target, { flags, mode: 0o600 }) as NodeJS.WritableStream & {
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
