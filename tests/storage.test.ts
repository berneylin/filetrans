import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '', encryption: true }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? state.userData : os.tmpdir()) },
  safeStorage: {
    isEncryptionAvailable: (): boolean => state.encryption,
    encryptString: (value: string): Buffer => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer): string => {
      if (!state.encryption) throw new Error('Encryption is not available')
      const text = buffer.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('无法解密')
      return text.slice(4)
    }
  }
}))

let work = ''

function sitesFile(): string {
  return path.join(work, 'sites.json')
}

function writeSites(value: unknown): void {
  writeFileSync(sitesFile(), JSON.stringify(value, null, 2))
}

function readSites(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(sitesFile(), 'utf8')) as Array<Record<string, unknown>>
}

const newSite = {
  name: '站点',
  host: 'h',
  port: 22,
  username: 'u',
  authType: 'password' as const,
  rememberSecret: false
}

beforeEach(() => {
  vi.resetModules()
  work = mkdtempSync(path.join(os.tmpdir(), 'filetrans-storage-'))
  state.userData = work
  state.encryption = true
})

afterEach(() => rmSync(work, { recursive: true, force: true }))

describe('数据文件损坏', () => {
  it('sites.json 损坏时隔离原件，保存新站点不再清空历史', async () => {
    const storage = await import('../src/main/storage')
    writeFileSync(sitesFile(), '[{"id":"keep","name":"历史站点"},{坏JSON')

    expect(await storage.listSites()).toEqual([])
    expect(existsSync(sitesFile())).toBe(false)

    const issues = storage.consumeDataIssues()
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('sites.json')
    expect(issues[0]).toContain('已损坏')

    await storage.saveSite({ ...newSite, name: '新站点' })
    const stored = readSites()
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('新站点')

    const backups = readdirSync(work).filter((f) => f.includes('corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(path.join(work, backups[0]), 'utf8')).toContain('历史站点')
  })

  it('consumeDataIssues 读取后清空，警告只出现一次', async () => {
    const storage = await import('../src/main/storage')
    writeFileSync(sitesFile(), 'not json')
    await storage.listSites()
    expect(storage.consumeDataIssues()).toHaveLength(1)
    expect(storage.consumeDataIssues()).toEqual([])
  })

  it('known-hosts.json 损坏时同样隔离原件', async () => {
    const storage = await import('../src/main/storage')
    writeFileSync(path.join(work, 'known-hosts.json'), '{ broken')
    expect(await storage.getKnownHost('h:22')).toBeUndefined()
    expect(storage.consumeDataIssues()).toHaveLength(1)
  })

  it('校验失败（非数组）同样隔离', async () => {
    const storage = await import('../src/main/storage')
    writeSites({ not: 'an array' })
    expect(await storage.listSites()).toEqual([])
    expect(storage.consumeDataIssues()).toHaveLength(1)
  })
})

describe('凭据加密', () => {
  it('加密可用时保存并取回密码', async () => {
    const storage = await import('../src/main/storage')
    const saved = await storage.saveSite({ ...newSite, rememberSecret: true, password: 'pw' })
    expect(saved.hasSecret).toBe(true)
    const record = await storage.getSiteWithSecret(saved.id)
    expect(record?.secret.password).toBe('pw')
  })

  it('无密钥环时保存密码直接报错，不再静默回退旧凭据', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite, rememberSecret: true, password: 'old' })
    expect(first.hasSecret).toBe(true)

    state.encryption = false
    await expect(
      storage.saveSite({ id: first.id, ...newSite, rememberSecret: true, password: 'new' })
    ).rejects.toThrow('没有可用的密钥环')

    const stored = readSites()
    expect(stored).toHaveLength(1)
    expect(stored[0].secret).toBeDefined()
    await expect(storage.getSiteWithSecret(first.id)).rejects.toThrow('无法解密')
  })

  it('勾选记住但未提供密码时不清除已有凭据', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite, rememberSecret: true, password: 'pw' })
    const second = await storage.saveSite({ id: first.id, ...newSite, rememberSecret: true })
    expect(second.hasSecret).toBe(true)
    expect((await storage.getSiteWithSecret(first.id))?.secret.password).toBe('pw')
  })

  it('取消记住时清除凭据', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite, rememberSecret: true, password: 'pw' })
    const second = await storage.saveSite({ id: first.id, ...newSite, rememberSecret: false })
    expect(second.hasSecret).toBe(false)
  })

  it('无法解密时报明确错误', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite, rememberSecret: true, password: 'pw' })
    const record = await storage.getSiteWithSecret(first.id)
    expect(record?.secret.password).toBe('pw')

    const stored = readSites()[0]
    stored.secret = Buffer.from('garbage', 'utf8').toString('base64')
    writeSites([stored])

    await expect(storage.getSiteWithSecret(first.id)).rejects.toThrow('无法解密')
  })

  it('站点不存在时返回 null', async () => {
    const storage = await import('../src/main/storage')
    expect(await storage.getSiteWithSecret('missing')).toBeNull()
  })
})

describe('站点增删', () => {
  it('保存后列表包含站点，secret 不透出', async () => {
    const storage = await import('../src/main/storage')
    await storage.saveSite({ ...newSite, rememberSecret: true, password: 'pw' })
    const sites = await storage.listSites()
    expect(sites).toHaveLength(1)
    expect(sites[0]).not.toHaveProperty('secret')
    expect(sites[0].hasSecret).toBe(true)
  })

  it('重复保存同一 id 不产生重复项', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite })
    await storage.saveSite({ ...newSite, id: first.id, name: '改名' })
    const sites = await storage.listSites()
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('改名')
  })

  it('删除站点', async () => {
    const storage = await import('../src/main/storage')
    const first = await storage.saveSite({ ...newSite })
    await storage.deleteSite(first.id)
    expect(await storage.listSites()).toEqual([])
  })

  it('写入使用临时文件后原子替换，不残留 tmp', async () => {
    const storage = await import('../src/main/storage')
    await storage.saveSite({ ...newSite })
    const files = (await import('node:fs')).readdirSync(work)
    expect(files).toEqual(['sites.json'])
  })
})

describe('known hosts', () => {
  it('信任后可取回指纹', async () => {
    const storage = await import('../src/main/storage')
    await storage.trustKnownHost('h:22', 'SHA256:abc')
    expect((await storage.getKnownHost('h:22'))?.fingerprint).toBe('SHA256:abc')
  })

  it('未记录的主机返回 undefined', async () => {
    const storage = await import('../src/main/storage')
    expect(await storage.getKnownHost('other:22')).toBeUndefined()
  })
})

describe('encryptionAvailable', () => {
  it('跟随 safeStorage 状态', async () => {
    const storage = await import('../src/main/storage')
    state.encryption = true
    expect(storage.encryptionAvailable()).toBe(true)
    state.encryption = false
    expect(storage.encryptionAvailable()).toBe(false)
  })
})
