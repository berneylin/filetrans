import { describe, expect, it } from 'vitest'
import {
  bitsToMode,
  formatDate,
  formatEta,
  formatSize,
  modeToBits,
  modeToOctal,
  modeToPermissionString,
  octalToMode,
  typeFromMode
} from '@shared/format'

describe('modeToPermissionString', () => {
  it('格式化普通文件', () => {
    expect(modeToPermissionString(0o100644)).toBe('-rw-r--r--')
  })
  it('格式化目录', () => {
    expect(modeToPermissionString(0o040755)).toBe('drwxr-xr-x')
  })
  it('格式化符号链接', () => {
    expect(modeToPermissionString(0o120777)).toBe('lrwxrwxrwx')
  })
  it('处理可执行文件', () => {
    expect(modeToPermissionString(0o100755)).toBe('-rwxr-xr-x')
  })
})

describe('typeFromMode', () => {
  it('识别目录/文件/链接', () => {
    expect(typeFromMode(0o040755)).toBe('directory')
    expect(typeFromMode(0o100644)).toBe('file')
    expect(typeFromMode(0o120777)).toBe('symlink')
    expect(typeFromMode(0o010644)).toBe('other')
  })
})

describe('权限转换', () => {
  it('modeToOctal 保留 setuid 位', () => {
    expect(modeToOctal(0o100644)).toBe('644')
    expect(modeToOctal(0o104755)).toBe('4755')
  })
  it('octalToMode 校验非法输入', () => {
    expect(octalToMode('755')).toBe(0o755)
    expect(() => octalToMode('999')).toThrow()
    expect(() => octalToMode('abc')).toThrow()
  })
  it('bits 与 mode 互相转换', () => {
    const bits = modeToBits(0o640)
    expect(bits.owner.read).toBe(true)
    expect(bits.owner.write).toBe(true)
    expect(bits.owner.execute).toBe(false)
    expect(bits.group.read).toBe(true)
    expect(bits.other.read).toBe(false)
    expect(bitsToMode(bits)).toBe(0o640)
  })
})

describe('formatSize', () => {
  it('按单位格式化', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })
})

describe('formatDate', () => {
  it('空值返回空串', () => {
    expect(formatDate(0)).toBe('')
  })
  it('格式化时间', () => {
    const ms = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(formatDate(ms)).toBe('2026-01-02 03:04')
  })
})

describe('formatEta', () => {
  it('无效输入返回空串', () => {
    expect(formatEta(0, 1024)).toBe('')
    expect(formatEta(-1, 1024)).toBe('')
    expect(formatEta(1024, 0)).toBe('')
    expect(formatEta(1024, -1)).toBe('')
  })
  it('按秒/分/小时格式化', () => {
    expect(formatEta(30 * 1024, 1024)).toBe('剩余 30 秒')
    expect(formatEta(90 * 1024, 1024)).toBe('剩余 1 分 30 秒')
    expect(formatEta(3600 * 1024, 1024)).toBe('剩余 1 小时')
    expect(formatEta(3900 * 1024, 1024)).toBe('剩余 1 小时 5 分')
  })
  it('超过一天显示上限', () => {
    expect(formatEta(25 * 3600 * 1024, 1024)).toBe('剩余 > 1 天')
  })
})
