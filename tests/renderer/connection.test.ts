import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteConfig } from '@shared/types'

function makeSite(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    id: 'site-1',
    name: '测试站点',
    host: 'h',
    port: 22,
    username: 'u',
    authType: 'password',
    rememberSecret: false,
    hasSecret: false,
    ...overrides
  }
}

function makeApi(site: SiteConfig = makeSite()) {
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
    sites: {
      list: vi.fn(async () => [site])
    }
  }
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

function installWindow(api: ReturnType<typeof makeApi>): void {
  ;(globalThis as unknown as Record<string, unknown>).window = { api }
}

describe('标签页打开站点时使用默认路径', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
  })

  it('跳转到默认远程路径', async () => {
    const api = makeApi(makeSite({ remotePath: '/data/www' }))
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    const tab = useTabs.getState().activeTab()
    expect(tab?.status).toBe('connected')
    expect(tab?.path).toBe('/data/www')
    expect(api.sftp.list).toHaveBeenCalledWith('s1', '/data/www')
  })

  it('默认路径无效时回退到主目录', async () => {
    const api = makeApi(makeSite({ remotePath: '/nonexistent' }))
    api.sftp.list = vi.fn(async (_sessionId: string, target: string) => {
      if (target === '/nonexistent') throw new Error('路径不存在')
      return { path: target, parent: '/', entries: [] }
    })
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    expect(useTabs.getState().activeTab()?.path).toBe('/home/test')
  })

  it('未设置默认路径时进入主目录', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    expect(useTabs.getState().activeTab()?.path).toBe('/home/test')
  })

  it('输入密码但未保存时使用直接连接', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1', { password: 'pw' })

    expect(api.sftp.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'h', username: 'u', password: 'pw' })
    )
    expect(api.sftp.connectSite).not.toHaveBeenCalled()
  })

  it('可以同时打开多个标签页并独立关闭', async () => {
    const api = makeApi()
    let seq = 0
    api.sftp.connectSite = vi.fn(async () => {
      seq++
      return { sessionId: `s${seq}`, host: 'h', port: 22, username: 'u' }
    })
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    await useTabs.getState().openSite('site-1')
    expect(useTabs.getState().tabs.length).toBe(2)
    const first = useTabs.getState().tabs[0]
    const second = useTabs.getState().tabs[1]
    expect(useTabs.getState().activeId).toBe(second.id)

    await useTabs.getState().closeTab(second.id)
    expect(api.sftp.disconnect).toHaveBeenCalledWith('s2')
    expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([first.id])
    expect(useTabs.getState().activeId).toBe(first.id)

    await useTabs.getState().closeTab(first.id)
    expect(useTabs.getState().tabs.length).toBe(0)
    expect(useTabs.getState().activeId).toBeNull()
  })

  it('导航时记录历史，返回上一次路径不记录入历史', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''
    const path = (): string | undefined => useTabs.getState().activeTab()?.path
    const back = (): string[] => useTabs.getState().activeTab()?.back ?? []

    await useTabs.getState().navigate(id, '/data')
    await useTabs.getState().navigate(id, '/data/www')
    expect(path()).toBe('/data/www')
    expect(back()).toEqual(['/home/test', '/data'])

    await useTabs.getState().refresh(id)
    expect(back()).toEqual(['/home/test', '/data'])

    await useTabs.getState().goBack(id)
    expect(path()).toBe('/data')
    expect(back()).toEqual(['/home/test'])

    await useTabs.getState().goBack(id)
    expect(path()).toBe('/home/test')
    expect(back()).toEqual([])

    await useTabs.getState().goBack(id)
    expect(path()).toBe('/home/test')
  })

  it('返回上级目录同样进入历史', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''

    await useTabs.getState().navigate(id, '/data')
    await useTabs.getState().navigateUp(id)
    expect(useTabs.getState().activeTab()?.path).toBe('/')
    expect(useTabs.getState().activeTab()?.back).toEqual(['/home/test', '/data'])
  })
})

describe('标签导航竞态与历史', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
  })

  it('初始默认路径被更新导航抢占时不回退到主目录', async () => {
    const list = vi.fn(async (_sessionId: string, target: string) => {
      if (target === '/data/www') {
        await new Promise((r) => setTimeout(r, 10))
        const tabs = await import('../../src/renderer/src/stores/tabs')
        const nav = tabs.useTabs.getState().navigate(tabs.useTabs.getState().activeId ?? '', '/user/dir')
        await new Promise((r) => setTimeout(r, 30))
        await nav
        return { path: target, parent: '/', entries: [] }
      }
      return { path: target, parent: '/', entries: [] }
    })
    const api = {
      sftp: {
        connectSite: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        connect: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        disconnect: vi.fn(async () => undefined),
        home: vi.fn(async () => '/home/test'),
        list
      },
      sites: { list: vi.fn(async () => [makeSite({ remotePath: '/data/www' })]) }
    }
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')
    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    expect(useTabs.getState().activeTab()?.path).toBe('/user/dir')
  })

  it('返回失败时历史项保留', async () => {
    let allowHome = true
    const list = vi.fn(async (_s: string, target: string) => {
      if (target === '/home/test' && !allowHome) throw new Error('权限不足')
      return { path: target, parent: '/', entries: [] }
    })
    const api = {
      sftp: {
        connectSite: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        connect: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        disconnect: vi.fn(async () => undefined),
        home: vi.fn(async () => '/home/test'),
        list
      },
      sites: { list: vi.fn(async () => [makeSite()]) }
    }
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')
    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''

    await useTabs.getState().navigate(id, '/data')
    expect(useTabs.getState().activeTab()?.back).toEqual(['/home/test'])

    allowHome = false
    await useTabs.getState().goBack(id)
    const tab = useTabs.getState().activeTab()
    expect(tab?.path).toBe('/data')
    expect(tab?.back).toEqual(['/home/test'])
  })

  it('关闭标签确认取消后在途加载完成时恢复正常', async () => {
    const release: { resolve: () => void } = { resolve: () => undefined }
    const list = vi.fn(async (_s: string, target: string) => {
      if (target === '/slow') {
        await new Promise<void>((resolve) => {
          release.resolve = resolve
        })
      }
      return { path: target, parent: '/', entries: [] }
    })
    const api = {
      sftp: {
        connectSite: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        connect: vi.fn(async () => ({ sessionId: 's1', host: 'h', port: 22, username: 'u' })),
        disconnect: vi.fn(async () => undefined),
        home: vi.fn(async () => '/home/test'),
        list
      },
      sites: { list: vi.fn(async () => [makeSite()]) }
    }
    installWindow(api)
    const { useSites } = await import('../../src/renderer/src/stores/sites')
    const { useTabs } = await import('../../src/renderer/src/stores/tabs')
    const { useTransfers } = await import('../../src/renderer/src/stores/transfers')
    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''

    const pending = useTabs.getState().navigate(id, '/slow')
    useTransfers.setState({
      groups: [{ id: 'g1', sessionId: 's1', status: 'active' } as never]
    })
    ;(globalThis as unknown as { window: Record<string, unknown> }).window.confirm = () => false

    await useTabs.getState().closeTab(id)
    expect(useTabs.getState().tabs.some((tab) => tab.id === id)).toBe(true)
    expect(api.sftp.disconnect).not.toHaveBeenCalled()

    release.resolve()
    await pending
    expect(useTabs.getState().activeTab()?.loading).toBe(false)
  })
})
