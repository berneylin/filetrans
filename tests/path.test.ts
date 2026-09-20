import { describe, expect, it } from 'vitest'
import {
  escapesParent,
  posixBasename,
  posixDirname,
  posixJoin,
  posixNormalize,
  posixParent,
  posixRelative
} from '@shared/path'

describe('posixNormalize', () => {
  it('处理空值', () => {
    expect(posixNormalize('')).toBe('.')
  })
  it('清理相对路径', () => {
    expect(posixNormalize('./a//b/../c')).toBe('a/c')
  })
  it('保留绝对路径前缀', () => {
    expect(posixNormalize('/a/b/../c')).toBe('/a/c')
    expect(posixNormalize('/')).toBe('/')
    expect(posixNormalize('/..')).toBe('/')
  })
  it('保留前导 ..', () => {
    expect(posixNormalize('../a/../../b')).toBe('../../b')
  })
})

describe('posixJoin', () => {
  it('拼接路径', () => {
    expect(posixJoin('/home/user', 'dir', 'file.txt')).toBe('/home/user/dir/file.txt')
  })
  it('处理绝对路径拼接', () => {
    expect(posixJoin('/home/user', '/etc', 'hosts')).toBe('/home/user/etc/hosts')
  })
  it('规范化结果', () => {
    expect(posixJoin('/a/', '/b/', '..', 'c')).toBe('/a/c')
  })
})

describe('posixDirname / posixBasename', () => {
  it('取父目录', () => {
    expect(posixDirname('/a/b/c')).toBe('/a/b')
    expect(posixDirname('/a')).toBe('/')
    expect(posixDirname('a')).toBe('.')
  })
  it('取文件名', () => {
    expect(posixBasename('/a/b/c.txt')).toBe('c.txt')
    expect(posixBasename('/a/b')).toBe('b')
    expect(posixBasename('/')).toBe('/')
  })
})

describe('posixParent', () => {
  it('根目录没有父级', () => {
    expect(posixParent('/')).toBeNull()
  })
  it('返回父级路径', () => {
    expect(posixParent('/home/user')).toBe('/home')
    expect(posixParent('/home')).toBe('/')
  })
})

describe('posixRelative', () => {
  it('同目录返回相对文件名', () => {
    expect(posixRelative('/dst/a', '/dst/b')).toBe('../b')
    expect(posixRelative('/dst/sub', '/dst/other/file.txt')).toBe('../other/file.txt')
  })
  it('子路径', () => {
    expect(posixRelative('/dst/a', '/dst/a/b/c')).toBe('b/c')
  })
  it('相同路径返回点', () => {
    expect(posixRelative('/dst/a', '/dst/a')).toBe('.')
  })
  it('绝对与相对不匹配时返回原路径', () => {
    expect(posixRelative('/dst/a', 'b/c')).toBe('b/c')
  })
})

describe('escapesParent', () => {
  it('拒绝相对路径穿越到父目录之外', () => {
    expect(escapesParent('/home/user', '../escaped')).toBe(true)
    expect(escapesParent('/home/user', '../../etc')).toBe(true)
    expect(escapesParent('/a/b/c', '..')).toBe(true)
  })

  it('允许目录内的多级与自引用', () => {
    expect(escapesParent('/home/user', '项目/新 目录/输出')).toBe(false)
    expect(escapesParent('/home/user', ' a//b/c/ ')).toBe(false)
    expect(escapesParent('/home/user', 'a/../b')).toBe(false)
    expect(escapesParent('/home/user', '.')).toBe(false)
    expect(escapesParent('/home/user', '')).toBe(false)
  })

  it('绝对路径不视为穿越（按既定行为单独处理）', () => {
    expect(escapesParent('/home/user', '/mnt/data')).toBe(false)
    expect(escapesParent('/home/user', '/etc')).toBe(false)
  })
})
