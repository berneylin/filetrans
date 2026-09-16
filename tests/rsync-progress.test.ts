import { describe, expect, it } from 'vitest'
import { isProgressLine, normalizeNameLine, parseProgressLine } from '../src/main/rsync/progress'

describe('parseProgressLine', () => {
  it('解析完整进度行（含 xfr# 与 to-chk）', () => {
    const progress = parseProgressLine(
      '     25,165,824  57%    1.38GB/s    0:00:00 (xfr#1, to-chk=3/5)'
    )
    expect(progress).toEqual({
      bytes: 25165824,
      percent: 57,
      speedBytesPerSec: Math.round(1.38 * 1024 ** 3),
      transferredFiles: 1,
      toCheck: 3,
      totalChecks: 5
    })
  })

  it('解析无千分位分隔符的字节', () => {
    const progress = parseProgressLine('      123456  12%  512.00kB/s  0:00:01 (xfr#2, to-chk=1/8)')
    expect(progress?.bytes).toBe(123456)
    expect(progress?.speedBytesPerSec).toBe(512 * 1024)
  })

  it('无单位后缀时按 B/s 处理', () => {
    const progress = parseProgressLine('        100   0%  100B/s  0:00:01 (xfr#0, to-chk=4/4)')
    expect(progress?.speedBytesPerSec).toBe(100)
  })

  it('尚未传输任何文件时允许缺少 xfr#', () => {
    const progress = parseProgressLine('     32,768   0%  0.00kB/s  0:00:00  ')
    expect(progress).not.toBe(null)
    expect(progress?.transferredFiles).toBe(null)
    expect(progress?.toCheck).toBe(null)
    expect(progress?.bytes).toBe(32768)
  })

  it('识别 ir-chk 变体', () => {
    const progress = parseProgressLine('        0   0%  0.00kB/s  0:00:00 (xfr#0, ir-chk=1023/1025)')
    expect(progress?.toCheck).toBe(1023)
    expect(progress?.totalChecks).toBe(1025)
  })

  it('百分比 100% 与最终 to-chk=0', () => {
    const progress = parseProgressLine(
      '     44,040,198 100%    1.52GB/s    0:00:00 (xfr#3, to-chk=0/5)'
    )
    expect(progress?.percent).toBe(100)
    expect(progress?.toCheck).toBe(0)
  })

  it('非进度行返回 null', () => {
    expect(parseProgressLine('big1.bin')).toBe(null)
    expect(parseProgressLine('')).toBe(null)
    expect(parseProgressLine('some random text')).toBe(null)
  })

  it('isProgressLine 辅助判断', () => {
    expect(isProgressLine('  1,234  10%  1.00kB/s  0:00:01 (xfr#1, to-chk=1/2)')).toBe(true)
    expect(isProgressLine('sub/a.txt')).toBe(false)
  })
})

describe('parseProgressLine (openrsync)', () => {
  it('解析进行中行（含速率）', () => {
    const progress = parseProgressLine('       12345678  45%   12.34MB/s   00:00:12', 'openrsync')
    expect(progress?.bytes).toBe(12345678)
    expect(progress?.percent).toBe(45)
    expect(progress?.speedBytesPerSec).toBe(Math.round(12.34 * 1024 ** 2))
    expect(progress?.finished).toBe(false)
    expect(progress?.transferredFiles).toBe(null)
  })

  it('速率低于 1KB/s 时没有速率字段', () => {
    const progress = parseProgressLine('          10240  20%   00:00:03', 'openrsync')
    expect(progress?.bytes).toBe(10240)
    expect(progress?.percent).toBe(20)
    expect(progress?.speedBytesPerSec).toBe(null)
  })

  it('解析完成行（xfer# 与 to-check）', () => {
    const progress = parseProgressLine(
      '       25165824 100%   25.17MB/s   00:00:12 (xfer#3, to-check=2/5)',
      'openrsync'
    )
    expect(progress).toEqual({
      bytes: 25165824,
      percent: 100,
      speedBytesPerSec: Math.round(25.17 * 1024 ** 2),
      transferredFiles: 3,
      toCheck: 2,
      totalChecks: 5,
      finished: true
    })
  })

  it('KB/s 按 1024 换算', () => {
    const progress = parseProgressLine('             512  50%    1.50KB/s   00:00:01', 'openrsync')
    expect(progress?.speedBytesPerSec).toBe(1536)
  })

  it('GNU 行不会被误判为 openrsync', () => {
    const progress = parseProgressLine(
      '     25,165,824  57%    1.38GB/s    0:00:00 (xfr#1, to-chk=3/5)'
    )
    expect(progress?.finished).toBe(undefined)
    expect(progress?.transferredFiles).toBe(1)
  })
})

describe('normalizeNameLine', () => {
  it('提取文件名并去掉目录尾部斜杠', () => {
    expect(normalizeNameLine('sub/a.txt')).toBe('sub/a.txt')
    expect(normalizeNameLine('sub/')).toBe('sub')
  })

  it('过滤空行与噪音行', () => {
    expect(normalizeNameLine('')).toBe(null)
    expect(normalizeNameLine('   ')).toBe(null)
    expect(normalizeNameLine('sending incremental file list')).toBe(null)
    expect(normalizeNameLine('created directory dst')).toBe(null)
    expect(normalizeNameLine('./')).toBe(null)
  })
})
