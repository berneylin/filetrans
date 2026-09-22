import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COLUMNS,
  MIN_WIDTHS,
  columnTemplate,
  fitColumnTemplate,
  preferredWidth
} from '../../src/renderer/src/stores/columns'

const USER_LOCAL = { name: 168, size: 96, type: 56, mtime: 259, permissions: 100 }
const USER_REMOTE = { name: 235, size: 96, type: 56, mtime: 196, permissions: 100 }

function widths(template: string): number[] {
  return template.split(' ').map((part) => Number(part.replace('px', '')))
}

describe('preferredWidth', () => {
  it('auto 与过小值都落到最小值', () => {
    expect(preferredWidth(DEFAULT_COLUMNS, 'name')).toBe(MIN_WIDTHS.name)
    expect(preferredWidth({ ...DEFAULT_COLUMNS, size: 10 }, 'size')).toBe(MIN_WIDTHS.size)
    expect(preferredWidth({ ...DEFAULT_COLUMNS, mtime: 300 }, 'mtime')).toBe(300)
  })
})

describe('columnTemplate', () => {
  it('auto 名称列用 1fr，其余为固定像素', () => {
    expect(columnTemplate(DEFAULT_COLUMNS)).toBe('minmax(140px, 1fr) 84px 64px 136px 100px')
  })
})

describe('fitColumnTemplate', () => {
  it('宽度不足时按超出最小值的部分等比收缩，且不低于最小值', () => {
    const fitted = widths(fitColumnTemplate(USER_LOCAL, 526))
    expect(fitted).toHaveLength(5)
    expect(fitted.reduce((a, b) => a + b, 0)).toBe(526)
    expect(fitted[0]).toBeGreaterThanOrEqual(MIN_WIDTHS.name)
    expect(fitted[1]).toBeGreaterThanOrEqual(MIN_WIDTHS.size)
    expect(fitted[2]).toBeGreaterThanOrEqual(MIN_WIDTHS.type)
    expect(fitted[3]).toBeGreaterThanOrEqual(MIN_WIDTHS.mtime)
    expect(fitted[4]).toBeGreaterThanOrEqual(MIN_WIDTHS.permissions)
    expect(fitted[3]).toBeLessThan(USER_LOCAL.mtime)
  })

  it('远程面板配置同样收进可用宽度', () => {
    const fitted = widths(fitColumnTemplate(USER_REMOTE, 526))
    expect(fitted.reduce((a, b) => a + b, 0)).toBe(526)
    expect(Math.max(...fitted)).toBeLessThanOrEqual(Math.max(...widths(columnTemplate(USER_REMOTE))))
  })

  it('宽度足够时保留用户宽度，auto 名称列吸收剩余空间', () => {
    expect(fitColumnTemplate(DEFAULT_COLUMNS, 900)).toBe('516px 84px 64px 136px 100px')
  })

  it('固定名称列在宽度足够时原样保留，剩余空间留白', () => {
    expect(fitColumnTemplate({ ...DEFAULT_COLUMNS, name: 200 }, 600)).toBe(
      '200px 84px 64px 136px 100px'
    )
    expect(fitColumnTemplate(USER_LOCAL, 800)).toBe('168px 96px 56px 259px 100px')
  })

  it('所有最小值之和也放不下时整体等比缩放', () => {
    const fitted = widths(fitColumnTemplate(USER_LOCAL, 300))
    expect(fitted.reduce((a, b) => a + b, 0)).toBe(300)
    expect(fitted.every((width) => width > 0)).toBe(true)
  })

  it('任何宽度下都不会溢出到相邻面板', () => {
    for (const available of [200, 320, 400, 526, 536, 700, 1200]) {
      for (const config of [DEFAULT_COLUMNS, USER_LOCAL, USER_REMOTE]) {
        const fitted = widths(fitColumnTemplate(config, available))
        expect(fitted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(available)
      }
    }
  })

  it('auto 名称列在任何宽度下都填满可用宽度', () => {
    for (const available of [200, 320, 400, 526, 536, 700, 1200]) {
      const fitted = widths(fitColumnTemplate(DEFAULT_COLUMNS, available))
      expect(fitted.reduce((a, b) => a + b, 0)).toBe(available)
    }
  })

  it('可用宽度未知时回落到未收缩模板', () => {
    expect(fitColumnTemplate(USER_LOCAL, 0)).toBe(columnTemplate(USER_LOCAL))
    expect(fitColumnTemplate(USER_LOCAL, -1)).toBe(columnTemplate(USER_LOCAL))
  })
})
