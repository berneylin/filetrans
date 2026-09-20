import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

export type RsyncDialect = 'gnu' | 'openrsync'

export interface RsyncInfo {
  path: string
  dialect: RsyncDialect
  version: string
  modern: boolean
  argProtected: boolean
  zstd: boolean
  label: string
}

export interface ParsedRsyncVersion {
  dialect: RsyncDialect
  version: string
  modern: boolean
  argProtected: boolean
  zstd: boolean
}

const execFileAsync = promisify(execFile)

const PREFERRED_PATHS = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync']

export function parseRsyncVersion(stdout: string): ParsedRsyncVersion | null {
  if (/openrsync/i.test(stdout)) {
    const version = /rsync version ([\d.]+)/i.exec(stdout)?.[1] ?? 'unknown'
    return {
      dialect: 'openrsync',
      version: `${version} compatible`,
      modern: false,
      argProtected: false,
      zstd: false
    }
  }
  const match = /rsync\s+version\s+(\d+)\.(\d+)\.(\d+)/i.exec(stdout)
  if (!match) return null
  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)
  const compressList = /Compress list:\s*\n\s*([^\n]+)/.exec(stdout)?.[1] ?? ''
  return {
    dialect: 'gnu',
    version: `${match[1]}.${match[2]}.${match[3]}`,
    modern: major > 3 || (major === 3 && minor >= 1),
    argProtected: major > 3 || (major === 3 && (minor > 2 || (minor === 2 && patch >= 4))),
    zstd: /zstd/.test(compressList)
  }
}

async function probe(path: string): Promise<RsyncInfo | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'])
    const parsed = parseRsyncVersion(stdout)
    if (!parsed) return null
    return {
      path,
      ...parsed,
      label:
        parsed.dialect === 'openrsync' ? `openrsync ${parsed.version}` : `GNU rsync ${parsed.version}`
    }
  } catch {
    return null
  }
}

export function probeRsyncPath(path: string): Promise<RsyncInfo | null> {
  return probe(path)
}

async function resolveOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [name])
    const resolved = stdout.trim().split('\n')[0]
    return resolved || null
  } catch {
    return null
  }
}

function rank(info: RsyncInfo): number {
  if (info.dialect === 'gnu' && info.modern) return 3
  if (info.dialect === 'gnu') return 2
  return 1
}

export async function resolveRsync(): Promise<RsyncInfo> {
  const candidates: string[] = []
  for (const candidate of PREFERRED_PATHS) {
    try {
      await fs.access(candidate)
      candidates.push(candidate)
    } catch {
      /* 该路径不存在 */
    }
  }
  const onPath = await resolveOnPath('rsync')
  if (onPath) candidates.push(onPath)
  candidates.push('/usr/bin/rsync')

  const seen = new Set<string>()
  const infos: RsyncInfo[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const info = await probe(candidate)
    if (info) infos.push(info)
  }
  if (infos.length === 0) {
    throw new Error('未检测到 rsync，无法使用同步功能（请先安装 rsync）')
  }
  infos.sort((a, b) => rank(b) - rank(a))
  return infos[0]
}
