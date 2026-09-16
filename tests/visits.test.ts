import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteConfig } from '@shared/types'

const SITE: SiteConfig = {
  id: 'site-1',
  name: '测试站点',
  host: 'h',
  port: 22,
  username: 'u',
  authType: 'password',
  rememberSecret: false,
  hasSecret: false
}

function makeStorage(): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
} {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  }
}

function makeApi() {
  return {
    sftp: {
      connectSite: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
      connect: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
      disconnect: vi.fn(async () => undefined),
      home: vi.fn(async () => '/home/test'),
      list: vi.fn(async (_sessionId: string, target: string) => ({
        path: target,
        parent: '/',
        entries: []
      }))
    },
    local: {
      home: vi.fn(async () => '/home/me'),
      list: vi.fn(async (target: string) => ({ path: target, parent: '/', entries: [] }))
    },
    sites: {
      list: vi.fn(async () => [SITE])
    }
  }
}

describe('pushRecent', () => {
  it('去重、最近优先、最多 5 条', async () => {
    const { pushRecent } = await import('../src/renderer/src/stores/visits')
    expect(pushRecent(undefined, '/a')).toEqual(['/a'])
    expect(pushRecent(['/a', '/b'], '/a')).toEqual(['/a', '/b'])
    expect(pushRecent(['/a', '/b'], '')).toEqual(['/a', '/b'])
    expect(pushRecent(['/1', '/2', '/3', '/4', '/5'], '/6')).toEqual([
      '/6',
      '/1',
      '/2',
      '/3',
      '/4'
    ])
  })
})

describe('访问历史存储', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
  })

  it('本地与各站点分别记录且可清除', async () => {
    const { useVisits } = await import('../src/renderer/src/stores/visits')
    for (const path of ['/w1', '/w2', '/w3', '/w4', '/w5', '/w6']) {
      useVisits.getState().recordLocal(path)
    }
    expect(useVisits.getState().local).toEqual(['/w6', '/w5', '/w4', '/w3', '/w2'])

    useVisits.getState().recordRemote('site-1', '/data/a')
    useVisits.getState().recordRemote('site-1', '/data/b')
    useVisits.getState().recordRemote('site-2', '/other')
    expect(useVisits.getState().remote['site-1']).toEqual(['/data/b', '/data/a'])
    expect(useVisits.getState().remote['site-2']).toEqual(['/other'])

    useVisits.getState().clearRemote('site-1')
    expect(useVisits.getState().remote['site-1']).toBeUndefined()
    useVisits.getState().clearLocal()
    expect(useVisits.getState().local).toEqual([])
  })

  it('重启后从本地存储恢复', async () => {
    const first = await import('../src/renderer/src/stores/visits')
    first.useVisits.getState().recordLocal('/persist/a')
    first.useVisits.getState().recordRemote('site-1', '/remote/x')

    vi.resetModules()
    const second = await import('../src/renderer/src/stores/visits')
    expect(second.useVisits.getState().local).toEqual(['/persist/a'])
    expect(second.useVisits.getState().remote['site-1']).toEqual(['/remote/x'])
  })

  it('导航成功后写入本地与远程历史', async () => {
    const api = makeApi()
    ;(globalThis as unknown as Record<string, unknown>).window = { api }
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')
    const { useFiles } = await import('../src/renderer/src/stores/files')
    const { useVisits } = await import('../src/renderer/src/stores/visits')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''
    await useTabs.getState().navigate(id, '/data/www')
    expect(useVisits.getState().remote['site-1']).toEqual(['/data/www', '/home/test'])

    await useFiles.getState().initLocal()
    await useFiles.getState().navigate('/tmp')
    expect(useVisits.getState().local).toEqual(['/tmp', '/home/me'])
  })
})
