import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRsyncArgs } from '../src/main/rsync/args'

const RSYNC = '/usr/bin/rsync'

function isOpenrsync(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return /openrsync/i.test(execFileSync(RSYNC, ['--version'], { encoding: 'utf8' }))
  } catch {
    return false
  }
}

const describeMaybe = isOpenrsync() ? describe : describe.skip

describeMaybe('macOS 自带 openrsync 参数兼容性', () => {
  it('buildRsyncArgs 生成的参数可被 openrsync 接受并完成同步', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'filetrans-openrsync-'))
    try {
      const src = path.join(root, 'src')
      const dst = path.join(root, 'dst')
      mkdirSync(path.join(src, 'sub'), { recursive: true })
      mkdirSync(dst)
      writeFileSync(path.join(src, 'a.txt'), 'hello')
      writeFileSync(path.join(src, 'sub', 'b.txt'), 'world')
      writeFileSync(path.join(src, 'skip.log'), 'nope')

      const built = buildRsyncArgs({
        direction: 'upload',
        localPath: src,
        remotePath: '/placeholder',
        user: 'root',
        host: '127.0.0.1',
        rsh: '/bin/false',
        deleteExtraneous: false,
        exclude: ['skip*'],
        compress: true,
        modernGnu: false
      })
      const args: string[] = []
      for (let i = 0; i < built.length - 1; i++) {
        if (built[i] === '-e') {
          i++
          continue
        }
        args.push(built[i])
      }
      args.push(dst)

      const result = spawnSync(RSYNC, args, { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('hello')
      expect(readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8')).toBe('world')
      expect(() => readFileSync(path.join(dst, 'skip.log'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
