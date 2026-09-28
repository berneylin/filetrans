import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SiteConfig, SiteInput } from '@shared/types'

interface StoredSite {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
  remotePath?: string
  rememberSecret: boolean
  secret?: string
}

interface KnownHostRecord {
  fingerprint: string
  addedAt: number
}

function dataFile(name: string): string {
  return path.join(app.getPath('userData'), name)
}

const dataIssues: string[] = []

export function consumeDataIssues(): string[] {
  return dataIssues.splice(0, dataIssues.length)
}

async function quarantine(file: string): Promise<void> {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await fs.rename(file, backup)
    dataIssues.push(`数据文件 ${path.basename(file)} 已损坏，原件已保留为 ${path.basename(backup)}`)
  } catch {
    dataIssues.push(`数据文件 ${path.basename(file)} 已损坏且无法保留原件`)
  }
}

async function readJson<T>(file: string, fallback: T, validate?: (value: unknown) => value is T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return fallback
    throw new Error(`无法读取数据文件 ${path.basename(file)}（${code ?? err}）`)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (validate && !validate(parsed)) {
      await quarantine(file)
      return fallback
    }
    return parsed as T
  } catch {
    await quarantine(file)
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  try {
    const dir = await fs.open(path.dirname(file), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch {
    /* 目录 fsync 在部分平台不可用 */
  }
}

const fileLocks = new Map<string, Promise<unknown>>()

function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  fileLocks.set(file, next)
  void next.catch(() => undefined).then(() => {
    if (fileLocks.get(file) === next) fileLocks.delete(file)
  })
  return next
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(secret: { password?: string; passphrase?: string }): string {
  if (!encryptionAvailable()) {
    throw new Error('当前系统没有可用的密钥环，无法加密保存密码/口令（请取消勾选“记住密码”后重试）')
  }
  return safeStorage.encryptString(JSON.stringify(secret)).toString('base64')
}

function decryptSecret(value: string): { password?: string; passphrase?: string } {
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) as {
      password?: string
      passphrase?: string
    }
  } catch {
    throw new Error('无法解密已保存的凭据，请重新输入密码/口令')
  }
}

function toPublicSite(site: StoredSite): SiteConfig {
  const { secret, ...rest } = site
  return { ...rest, hasSecret: Boolean(secret) }
}

export async function listSites(): Promise<SiteConfig[]> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [], (value): value is StoredSite[] =>
    Array.isArray(value) && value.every((item) => item && typeof item === 'object')
  )
  return stored.map(toPublicSite)
}

export function saveSite(input: SiteInput): Promise<SiteConfig> {
  return withFileLock(dataFile('sites.json'), async (): Promise<SiteConfig> => {
    const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [], (value): value is StoredSite[] =>
      Array.isArray(value) && value.every((item) => item && typeof item === 'object')
    )
    const id = input.id ?? randomUUID()
    const existing = stored.find((s) => s.id === id)
    let secret = existing?.secret

    if (!input.rememberSecret) {
      secret = undefined
    } else if (input.password !== undefined || input.passphrase !== undefined) {
      secret = encryptSecret({ password: input.password, passphrase: input.passphrase })
    } else if (existing && existing.authType !== input.authType) {
      secret = undefined
    }
    if (secret && existing && secret === existing.secret) {
      try {
        const decrypted = decryptSecret(secret)
        secret = encryptSecret(
          input.authType === 'password'
            ? { password: decrypted.password }
            : { passphrase: decrypted.passphrase }
        )
      } catch {
        secret = undefined
      }
    }

    const site: StoredSite = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      keyPath: input.keyPath,
      remotePath: input.remotePath,
      rememberSecret: input.rememberSecret,
      secret
    }
    const next = existing
      ? stored.map((s) => (s.id === id ? site : s))
      : [...stored, site]
    await writeJson(dataFile('sites.json'), next)
    return toPublicSite(site)
  })
}

export function deleteSite(id: string): Promise<void> {
  return withFileLock(dataFile('sites.json'), async (): Promise<void> => {
    const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [], (value): value is StoredSite[] =>
      Array.isArray(value) && value.every((item) => item && typeof item === 'object')
    )
    await writeJson(
      dataFile('sites.json'),
      stored.filter((s) => s.id !== id)
    )
  })
}

export async function getSiteWithSecret(
  id: string
): Promise<{ site: SiteConfig; secret: { password?: string; passphrase?: string } } | null> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [], (value): value is StoredSite[] =>
    Array.isArray(value) && value.every((item) => item && typeof item === 'object')
  )
  const site = stored.find((s) => s.id === id)
  if (!site) return null
  return {
    site: toPublicSite(site),
    secret: site.secret ? decryptSecret(site.secret) : {}
  }
}

export async function getKnownHost(hostPort: string): Promise<KnownHostRecord | undefined> {
  const all = await readJson<Record<string, KnownHostRecord>>(
    dataFile('known-hosts.json'),
    {},
    (value): value is Record<string, KnownHostRecord> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
  )
  return all[hostPort]
}

export function trustKnownHost(hostPort: string, fingerprint: string): Promise<void> {
  return withFileLock(dataFile('known-hosts.json'), async (): Promise<void> => {
    const all = await readJson<Record<string, KnownHostRecord>>(
      dataFile('known-hosts.json'),
      {},
      (value): value is Record<string, KnownHostRecord> =>
        typeof value === 'object' && value !== null && !Array.isArray(value)
    )
    all[hostPort] = { fingerprint, addedAt: Date.now() }
    await writeJson(dataFile('known-hosts.json'), all)
  })
}
