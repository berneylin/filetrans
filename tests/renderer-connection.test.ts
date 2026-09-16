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

function installWindow(api: ReturnType<typeof makeApi>): void {
  ;(globalThis as unknown as Record<string, unknown>).window = { api }
}

describe('标签页打开站点时使用默认路径', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('跳转到默认远程路径', async () => {
    const api = makeApi(makeSite({ remotePath: '/data/www' }))
    installWindow(api)
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

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
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    expect(useTabs.getState().activeTab()?.path).toBe('/home/test')
  })

  it('未设置默认路径时进入主目录', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')

    expect(useTabs.getState().activeTab()?.path).toBe('/home/test')
  })

  it('输入密码但未保存时使用直接连接', async () => {
    const api = makeApi()
    installWindow(api)
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

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
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

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
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

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
    const { useSites } = await import('../src/renderer/src/stores/sites')
    const { useTabs } = await import('../src/renderer/src/stores/tabs')

    await useSites.getState().loadSites()
    await useTabs.getState().openSite('site-1')
    const id = useTabs.getState().activeTab()?.id ?? ''

    await useTabs.getState().navigate(id, '/data')
    await useTabs.getState().navigateUp(id)
    expect(useTabs.getState().activeTab()?.path).toBe('/')
    expect(useTabs.getState().activeTab()?.back).toEqual(['/home/test', '/data'])
  })
})
