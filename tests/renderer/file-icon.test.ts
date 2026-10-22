import { describe, expect, it } from 'vitest'
import { FILE_ICONS, fileKind } from '../../src/renderer/src/utils/fileIcon'

describe('文件类型图标', () => {
  it('按扩展名识别类型，大小写不敏感', () => {
    expect(fileKind('photo.JPG')).toBe('image')
    expect(fileKind('movie.mkv')).toBe('video')
    expect(fileKind('backup.tar.gz')).toBe('archive')
    expect(fileKind('index.ts')).toBe('code')
    expect(fileKind('deploy.sh')).toBe('script')
    expect(fileKind('package.json')).toBe('data')
    expect(fileKind('id_ed25519.pub')).toBe('key')
    expect(fileKind('README.md')).toBe('text')
  })

  it('无扩展名、隐藏文件与未知扩展名归为普通文件', () => {
    expect(fileKind('Makefile')).toBe('file')
    expect(fileKind('.bashrc')).toBe('file')
    expect(fileKind('trailing.')).toBe('file')
    expect(fileKind('data.unknownext')).toBe('file')
  })

  it('每种类型都有对应图标', () => {
    for (const name of ['a.png', 'a.mp4', 'a.mp3', 'a.zip', 'a.pdf', 'a.docx', 'a.csv', 'a']) {
      expect(FILE_ICONS[fileKind(name)].icon).toBeTruthy()
    }
  })
})
