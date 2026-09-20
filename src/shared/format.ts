import type { FileEntry } from './types'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

export function typeFromMode(mode: number): FileEntry['type'] {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory'
    case S_IFLNK:
      return 'symlink'
    case S_IFREG:
      return 'file'
    default:
      return 'other'
  }
}

export function modeToPermissionString(mode: number): string {
  const typeChar =
    (mode & S_IFMT) === S_IFDIR ? 'd' : (mode & S_IFMT) === S_IFLNK ? 'l' : '-'
  const bits = ['r', 'w', 'x']
  let out = typeChar
  for (let shift = 8; shift >= 0; shift--) {
    const bit = (mode >> shift) & 1
    out += bit ? bits[(8 - shift) % 3] : '-'
  }
  return out
}

export function modeToOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}

export function octalToMode(octal: string): number {
  const parsed = Number.parseInt(octal.trim(), 8)
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 0o7777) {
    throw new Error(`无效的权限值: ${octal}`)
  }
  return parsed
}

export function assertPermissionMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new Error(`无效的权限值: ${mode}`)
  }
  return mode
}

export interface PermissionBits {
  owner: { read: boolean; write: boolean; execute: boolean }
  group: { read: boolean; write: boolean; execute: boolean }
  other: { read: boolean; write: boolean; execute: boolean }
}

export function modeToBits(mode: number): PermissionBits {
  const read = (shift: number): boolean => ((mode >> shift) & 1) === 1
  return {
    owner: { read: read(8), write: read(7), execute: read(6) },
    group: { read: read(5), write: read(4), execute: read(3) },
    other: { read: read(2), write: read(1), execute: read(0) }
  }
}

export function bitsToMode(bits: PermissionBits): number {
  let mode = 0
  if (bits.owner.read) mode |= 0o400
  if (bits.owner.write) mode |= 0o200
  if (bits.owner.execute) mode |= 0o100
  if (bits.group.read) mode |= 0o040
  if (bits.group.write) mode |= 0o020
  if (bits.group.execute) mode |= 0o010
  if (bits.other.read) mode |= 0o004
  if (bits.other.write) mode |= 0o002
  if (bits.other.execute) mode |= 0o001
  return mode
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    value /= 1024
    unit = u
    if (value < 1024) break
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

export function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s} 秒`
  return `${s} 秒`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return ''
  return `${formatSize(bytesPerSecond)}/s`
}

export function formatEta(remainingBytes: number, speed: number): string {
  if (remainingBytes <= 0 || speed <= 0) return ''
  const total = Math.ceil(remainingBytes / speed)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h >= 24) return '剩余 > 1 天'
  if (h > 0) return m > 0 ? `剩余 ${h} 小时 ${m} 分` : `剩余 ${h} 小时`
  if (m > 0) return `剩余 ${m} 分 ${s} 秒`
  return `剩余 ${s} 秒`
}
