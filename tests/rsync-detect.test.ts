import { describe, expect, it } from 'vitest'
import { parseRsyncVersion } from '../src/main/rsync/detect'

describe('parseRsyncVersion', () => {
  it('识别 openrsync（macOS 自带）', () => {
    const info = parseRsyncVersion(
      'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n'
    )
    expect(info).toMatchObject({
      dialect: 'openrsync',
      version: '2.6.9 compatible',
      modern: false,
      zstd: false
    })
  })

  it('识别 GNU 3.1+ 与 zstd 能力', () => {
    const stdout = [
      'rsync  version 3.5.0  protocol version 32',
      'Copyright (C) 1996-2026 by Andrew Tridgell, Wayne Davison, and others.',
      'Capabilities:',
      '    64-bit files, 64-bit inums, socketpairs, symlinks',
      'Compress list:',
      '\tzstd lz4 zlibx zlib none',
      ''
    ].join('\n')
    expect(parseRsyncVersion(stdout)).toMatchObject({
      dialect: 'gnu',
      version: '3.5.0',
      modern: true,
      zstd: true
    })
  })

  it('GNU 3.0 视为旧版（无 --info=progress2）', () => {
    const stdout = 'rsync  version 3.0.9  protocol version 30\nCapabilities:\n'
    expect(parseRsyncVersion(stdout)).toMatchObject({ dialect: 'gnu', modern: false, zstd: false })
  })

  it('无法识别时返回 null', () => {
    expect(parseRsyncVersion('hello world')).toBe(null)
    expect(parseRsyncVersion('')).toBe(null)
  })
})
