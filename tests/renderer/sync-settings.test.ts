import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('parseBannedDirs', () => {
  it('按行拆分并忽略空白行', async () => {
    const { parseBannedDirs } = await import('../../src/renderer/src/utils/sync')
    expect(parseBannedDirs('/a\n  /b  \n\n   \n/c/')).toEqual(['/a', '/b', '/c/'])
    expect(parseBannedDirs('')).toEqual([])
    expect(parseBannedDirs('   \n  ')).toEqual([])
  })
})

describe('pickSyncPath', () => {
  it('面板中单选目录优先', async () => {
    const { pickSyncPath } = await import('../../src/renderer/src/utils/sync')
    expect(pickSyncPath('/w/current', ['/w/selected'], '/w/remembered')).toBe('/w/selected')
  })

  it('无单选时使用上次同步的目录', async () => {
    const { pickSyncPath } = await import('../../src/renderer/src/utils/sync')
    expect(pickSyncPath('/w/current', [], '/w/remembered')).toBe('/w/remembered')
    expect(pickSyncPath('/w/current', ['/w/a', '/w/b'], '/w/remembered')).toBe('/w/remembered')
  })

  it('都没有时回落到面板当前目录', async () => {
    const { pickSyncPath } = await import('../../src/renderer/src/utils/sync')
    expect(pickSyncPath('/w/current', [], '')).toBe('/w/current')
    expect(pickSyncPath('/w/current', ['/w/a', '/w/b'], '')).toBe('/w/current')
  })
})

describe('同步目录记忆与禁用列表', () => {
  beforeEach(() => {
    vi.resetModules()
    const storage = makeStorage()
    vi.stubGlobal('localStorage', storage)
    ;(globalThis as unknown as Record<string, unknown>).window = { api: {}, localStorage: storage }
  })

  it('记住本地目录，并按站点分别记住远程目录', async () => {
    const { useSettings } = await import('../../src/renderer/src/stores/settings')
    expect(useSettings.getState().syncLastLocal).toBe('')
    expect(useSettings.getState().syncLastRemote).toEqual({})
    expect(useSettings.getState().syncBannedPaths).toBe('')

    useSettings.getState().rememberSyncPaths('/w/a', '/remote/a', 'site-1')
    useSettings.getState().rememberSyncPaths('/w/b', '/remote/b', 'site-2')
    useSettings.getState().rememberSyncPaths('/w/c', '/remote/c2', 'site-1')

    expect(useSettings.getState().syncLastLocal).toBe('/w/c')
    expect(useSettings.getState().syncLastRemote).toEqual({
      'site-1': '/remote/c2',
      'site-2': '/remote/b'
    })
  })

  it('没有站点时不改动远程目录记忆', async () => {
    const { useSettings } = await import('../../src/renderer/src/stores/settings')
    useSettings.getState().rememberSyncPaths('/w/a', '/remote/a', 'site-1')
    useSettings.getState().rememberSyncPaths('/w/b', '/remote/b')

    expect(useSettings.getState().syncLastLocal).toBe('/w/b')
    expect(useSettings.getState().syncLastRemote).toEqual({ 'site-1': '/remote/a' })
  })

  it('重启后从本地存储恢复禁用列表与同步目录记忆', async () => {
    const first = await import('../../src/renderer/src/stores/settings')
    first.useSettings.getState().update({ syncBannedPaths: '/home/sunqy/repos\n/mnt/pfs/code' })
    first.useSettings.getState().rememberSyncPaths('/w/a', '/remote/a', 'site-1')

    vi.resetModules()
    const second = await import('../../src/renderer/src/stores/settings')
    expect(second.useSettings.getState().syncBannedPaths).toBe('/home/sunqy/repos\n/mnt/pfs/code')
    expect(second.useSettings.getState().syncLastLocal).toBe('/w/a')
    expect(second.useSettings.getState().syncLastRemote).toEqual({ 'site-1': '/remote/a' })
  })
})
