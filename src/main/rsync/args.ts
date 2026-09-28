import type { SyncDirection } from '@shared/types'

export interface RsyncTargetOptions {
  direction: SyncDirection
  localPath: string
  remotePath: string
  user: string
  host: string
  rsh: string
  deleteExtraneous: boolean
  exclude: string[]
  compress: boolean
  modernGnu?: boolean
  progress2?: boolean
  argProtected?: boolean
  zstd?: boolean
}

export function withTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : `${p}/`
}

const SAFE_REMOTE_PATH = /^[A-Za-z0-9._/@%+,:=-]+$/
const WILDCARD_RE = /[*?[\]]/
const WILDCARD_GLOBAL_RE = /[*?[\]]/g

function escapeWildcards(path: string): string {
  return path.replace(WILDCARD_GLOBAL_RE, (ch) => `\\${ch}`)
}

function quoteRemotePath(path: string, quote: boolean): string {
  if (!quote || SAFE_REMOTE_PATH.test(path)) return path
  return `'${path.replace(/'/g, `'\\''`)}'`
}

export function buildRsyncArgs(t: RsyncTargetOptions): string[] {
  const gnu = t.modernGnu ?? true
  const progress2 = gnu && (t.progress2 ?? false)
  const quote = !progress2 && !(t.argProtected ?? false)
  let forceQuote = false
  const args = gnu
    ? [
        '-a',
        ...(progress2 ? ['-s'] : []),
        '--partial-dir=.filetrans-rsync-partial',
        '--no-owner',
        '--no-group',
        progress2 ? '--info=progress2,name' : '--progress'
      ]
    : ['-rlptD', '--partial', '--progress']
  for (const pattern of t.exclude) {
    const trimmed = pattern.trim()
    if (trimmed) args.push(`--exclude=${trimmed}`)
  }
  if (t.deleteExtraneous) args.push('--delete')
  if (t.compress) args.push(gnu && t.zstd ? '--zc=zstd' : '-z')
  args.push('-e', t.rsh)
  const hasWildcard = WILDCARD_RE.test(t.remotePath)
  let remotePath = t.remotePath
  if (progress2) {
    if (hasWildcard && t.direction === 'download') {
      remotePath = escapeWildcards(remotePath)
    }
  } else if (hasWildcard && (t.argProtected ?? false)) {
    args.push('--old-args')
    forceQuote = true
  }
  const useQuote = quote || forceQuote
  args.push('--')
  const local = withTrailingSlash(t.localPath)
  const hostLiteral = t.host.includes(':') ? `[${t.host}]` : t.host
  const remote = `${t.user}@${hostLiteral}:`
  if (t.direction === 'upload') {
    args.push(local, `${remote}${quoteRemotePath(remotePath, useQuote)}`)
  } else {
    args.push(`${remote}${quoteRemotePath(withTrailingSlash(remotePath), useQuote)}`, local)
  }
  return args
}

export interface SshConfigOptions {
  host: string
  port: number
  user: string
  knownHostsFile: string
  keyPath?: string
  connectTimeout?: number
}

function quoteConfigValue(value: string): string {
  if (/["\\\n]/.test(value)) throw new Error(`路径包含不支持的字符: ${value}`)
  return `"${value}"`
}

export function buildSshConfig(opts: SshConfigOptions): string {
  const lines = [
    'Host *',
    `  HostName ${quoteConfigValue(opts.host)}`,
    `  Port ${opts.port}`,
    `  User ${quoteConfigValue(opts.user)}`,
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${quoteConfigValue(opts.knownHostsFile)}`,
    '  GlobalKnownHostsFile /dev/null',
    '  IdentityAgent none',
    '  NumberOfPasswordPrompts 1',
    '  ServerAliveInterval 15',
    '  ServerAliveCountMax 3',
    `  ConnectTimeout ${opts.connectTimeout ?? 20}`
  ]
  if (opts.keyPath) {
    lines.push('  PreferredAuthentications publickey')
    lines.push(`  IdentityFile ${quoteConfigValue(opts.keyPath)}`, '  IdentitiesOnly yes')
  } else {
    lines.push('  PubkeyAuthentication no')
  }
  return `${lines.join('\n')}\n`
}

export function buildRshScript(configPath: string): string {
  if (/["\\\n]/.test(configPath)) throw new Error('临时路径包含不支持的字符')
  return `#!/bin/sh\nexec ssh -F "${configPath}" "$@"\n`
}

export function buildAskpassScript(secretPath: string): string {
  if (/["\\\n]/.test(secretPath)) throw new Error('临时路径包含不支持的字符')
  return `#!/bin/sh\nexec cat "${secretPath}"\n`
}

export function parseHostKeyAlgorithm(blob: Buffer): string | null {
  if (blob.length < 4) return null
  const length = blob.readUInt32BE(0)
  if (length <= 0 || 4 + length > blob.length) return null
  const type = blob.toString('ascii', 4, 4 + length)
  return /^[a-zA-Z0-9.@-]+$/.test(type) ? type : null
}

export function knownHostsLine(
  host: string,
  port: number,
  keyType: string,
  keyBase64: string
): string {
  const id = port === 22 ? host : `[${host}]:${port}`
  return `${id} ${keyType} ${keyBase64}\n`
}
