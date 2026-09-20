import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildRsyncArgs } from '../src/main/rsync/args'
import { parseRsyncVersion } from '../src/main/rsync/detect'

const RSYNC = '/usr/bin/rsync'

let root = ''
let rsh = ''
let argvFile = ''

function argProtectedRsync(): boolean {
  try {
    const stdout = execFileSync(RSYNC, ['--version'], { encoding: 'utf8' })
    return parseRsyncVersion(stdout)?.argProtected === true
  } catch {
    return false
  }
}

const describeMaybe = argProtectedRsync() ? describe : describe.skip

function lastRemoteArg(args: string[]): string {
  const result = spawnSync(RSYNC, args, { stdio: 'ignore' })
  expect(result.error).toBeUndefined()
  const captured = execFileSync('cat', [argvFile], { encoding: 'utf8' }).trim()
  const start = captured.lastIndexOf('[') + 1
  return captured.slice(start, -1)
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'filetrans-remote-shell-'))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'a.txt'), 'hello')
  rsh = path.join(root, 'rsh')
  argvFile = path.join(root, 'argv')
  writeFileSync(
    rsh,
    `#!/bin/sh\n{ for a in "$@"; do printf "[%s]" "$a"; done; printf "\\n"; } > ${argvFile}\nexit 0\n`,
    { mode: 0o755 }
  )
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describeMaybe('远端 shell 收到的参数', () => {
  it('不加引号时 rsync 自带的转义可被远端 shell 正确还原', () => {
    const args = [
      '-a',
      '--partial',
      '--progress',
      '-e',
      rsh,
      path.join(root, 'src'),
      'root@10.0.0.2:/mnt/my dir'
    ]
    expect(lastRemoteArg(args)).toBe('/mnt/my\\ dir')
  })

  it('buildRsyncArgs 在本地 rsync 支持参数转义时不加引号', () => {
    const args = buildRsyncArgs({
      direction: 'upload',
      localPath: path.join(root, 'src'),
      remotePath: '/mnt/my dir',
      user: 'root',
      host: '10.0.0.2',
      rsh,
      deleteExtraneous: false,
      exclude: [],
      compress: false,
      modernGnu: true,
      progress2: false,
      argProtected: true
    })
    expect(args[args.length - 1]).toBe('root@10.0.0.2:/mnt/my dir')
    expect(lastRemoteArg(args)).toBe('/mnt/my\\ dir')
  })

  it('buildRsyncArgs 在本地 rsync 低于 3.2.4 时手工加引号', () => {
    const args = buildRsyncArgs({
      direction: 'upload',
      localPath: path.join(root, 'src'),
      remotePath: '/mnt/my dir',
      user: 'root',
      host: '10.0.0.2',
      rsh,
      deleteExtraneous: false,
      exclude: [],
      compress: false,
      modernGnu: true,
      progress2: false,
      argProtected: false
    })
    expect(args[args.length - 1]).toBe("root@10.0.0.2:'/mnt/my dir'")
    expect(lastRemoteArg(args)).toBe("\\'/mnt/my\\ dir\\'")
  })
})
