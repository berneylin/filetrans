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

describe('主题', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
  })

  it('跟随系统时取系统明暗，手动选择时忽略系统', async () => {
    const { resolveDark } = await import('../../src/renderer/src/stores/theme')
    expect(resolveDark('system', true)).toBe(true)
    expect(resolveDark('system', false)).toBe(false)
    expect(resolveDark('dark', false)).toBe(true)
    expect(resolveDark('light', true)).toBe(false)
  })

  it('默认跟随系统，选择后持久化保存', async () => {
    const { useTheme } = await import('../../src/renderer/src/stores/theme')
    expect(useTheme.getState().mode).toBe('system')
    useTheme.getState().setMode('dark')
    expect(JSON.parse(localStorage.getItem('filetrans-theme') ?? '{}').state.mode).toBe('dark')

    vi.resetModules()
    const reloaded = await import('../../src/renderer/src/stores/theme')
    expect(reloaded.useTheme.getState().mode).toBe('dark')
  })

  it('存储中的非法值回落为跟随系统', async () => {
    localStorage.setItem('filetrans-theme', JSON.stringify({ state: { mode: 'purple' }, version: 0 }))
    const { useTheme } = await import('../../src/renderer/src/stores/theme')
    expect(useTheme.getState().mode).toBe('system')
  })
})
