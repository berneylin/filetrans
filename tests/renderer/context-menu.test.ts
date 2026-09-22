import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '../../src/renderer/src/types'

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

function labels(items: MenuItem[]): string[] {
  return items.map((item) => (item.separator ? '---' : (item.label ?? '')))
}

describe('空白区域右键菜单', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', makeStorage())
    ;(globalThis as unknown as Record<string, unknown>).window = { api: {} }
  })

  it('本地空白区域：新建目录、清理临时文件、在文件浏览器中打开、刷新', async () => {
    const { openContextMenu } = await import('../../src/renderer/src/actions')
    const { useUi } = await import('../../src/renderer/src/stores/ui')

    openContextMenu('local', null, 10, 20)

    const menu = useUi.getState().menu
    expect(menu).not.toBeNull()
    expect(labels(menu?.items ?? [])).toEqual([
      '新建目录',
      '清理传输临时文件',
      '在文件浏览器中打开',
      '---',
      '刷新'
    ])
  })

  it('远程空白区域：新建目录、清理临时文件与刷新', async () => {
    const { openContextMenu } = await import('../../src/renderer/src/actions')
    const { useUi } = await import('../../src/renderer/src/stores/ui')

    openContextMenu('remote', null, 10, 20)

    const menu = useUi.getState().menu
    expect(labels(menu?.items ?? [])).toEqual([
      '新建目录',
      '清理传输临时文件',
      '---',
      '刷新'
    ])
  })

  it('空白区域的「在文件浏览器中打开」作用于当前目录', async () => {
    const { openContextMenu } = await import('../../src/renderer/src/actions')
    const { useUi } = await import('../../src/renderer/src/stores/ui')
    const { useFiles } = await import('../../src/renderer/src/stores/files')
    useFiles.setState((state) => ({ local: { ...state.local, path: '/home/sunqy' } }))

    const opened: string[] = []
    ;(globalThis as unknown as Record<string, unknown>).window = {
      api: {
        local: {
          openInBrowser: (target: string) => {
            opened.push(target)
            return Promise.resolve()
          }
        }
      }
    }

    openContextMenu('local', null, 10, 20)
    const item = useUi.getState().menu?.items.find((i) => i.label === '在文件浏览器中打开')
    expect(item).toBeDefined()
    item?.onClick?.()

    expect(opened).toEqual(['/home/sunqy'])
  })
})
