import { describe, expect, it } from 'vitest'
import { nextSiteName } from '../../src/renderer/src/utils/sites'

describe('nextSiteName', () => {
  it('空列表生成默认名称', () => {
    expect(nextSiteName([])).toBe('新站点')
  })

  it('默认名称被占用时递增序号', () => {
    expect(nextSiteName([{ name: '新站点' }])).toBe('新站点 2')
    expect(nextSiteName([{ name: '新站点' }, { name: '新站点 2' }])).toBe('新站点 3')
  })

  it('无关名称不参与递增', () => {
    expect(nextSiteName([{ name: '服务器' }, { name: '备份机' }])).toBe('新站点')
    expect(nextSiteName([{ name: '服务器' }, { name: '新站点' }])).toBe('新站点 2')
  })

  it('序号中间出现空洞时补齐', () => {
    expect(nextSiteName([{ name: '新站点' }, { name: '新站点 3' }])).toBe('新站点 2')
  })
})
