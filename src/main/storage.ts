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

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptSecret(secret: { password?: string; passphrase?: string }): string | undefined {
  const payload = JSON.stringify(secret)
  if (!encryptionAvailable()) return undefined
  return safeStorage.encryptString(payload).toString('base64')
}

function decryptSecret(value: string): { password?: string; passphrase?: string } {
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))) as {
      password?: string
      passphrase?: string
    }
  } catch {
    return {}
  }
}

function toPublicSite(site: StoredSite): SiteConfig {
  const { secret, ...rest } = site
  return { ...rest, hasSecret: Boolean(secret) }
}

export async function listSites(): Promise<SiteConfig[]> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [])
  return stored.map(toPublicSite)
}

export async function saveSite(input: SiteInput): Promise<SiteConfig> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [])
  const id = input.id ?? randomUUID()
  const existing = stored.find((s) => s.id === id)
  let secret = existing?.secret

  if (!input.rememberSecret) {
    secret = undefined
  } else if (input.password !== undefined || input.passphrase !== undefined) {
    secret = encryptSecret({ password: input.password, passphrase: input.passphrase }) ?? secret
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
  await writeJson(dataFile('sites.json'), [...stored.filter((s) => s.id !== id), site])
  return toPublicSite(site)
}

export async function deleteSite(id: string): Promise<void> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [])
  await writeJson(
    dataFile('sites.json'),
    stored.filter((s) => s.id !== id)
  )
}

export async function getSiteWithSecret(
  id: string
): Promise<{ site: SiteConfig; secret: { password?: string; passphrase?: string } } | null> {
  const stored = await readJson<StoredSite[]>(dataFile('sites.json'), [])
  const site = stored.find((s) => s.id === id)
  if (!site) return null
  return {
    site: toPublicSite(site),
    secret: site.secret ? decryptSecret(site.secret) : {}
  }
}

export async function getKnownHost(hostPort: string): Promise<KnownHostRecord | undefined> {
  const all = await readJson<Record<string, KnownHostRecord>>(dataFile('known-hosts.json'), {})
  return all[hostPort]
}

export async function trustKnownHost(hostPort: string, fingerprint: string): Promise<void> {
  const all = await readJson<Record<string, KnownHostRecord>>(dataFile('known-hosts.json'), {})
  all[hostPort] = { fingerprint, addedAt: Date.now() }
  await writeJson(dataFile('known-hosts.json'), all)
}
