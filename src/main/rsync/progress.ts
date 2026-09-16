import type { RsyncDialect } from './detect'

export interface RsyncProgress {
  bytes: number | null
  percent: number | null
  speedBytesPerSec: number | null
  transferredFiles: number | null
  toCheck: number | null
  totalChecks: number | null
  finished?: boolean
}

const UNITS: Record<string, number> = {
  k: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4
}

const OPENRSYNC_UNITS: Record<string, number> = {
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4
}

const PROGRESS_RE =
  /^\s*([\d,.]+)\s+(\d{1,3})%\s+([\d.]+)([kMGT]?)B\/s\s+\d+:\d{2}:\d{2}\s*(?:\((?:xfr#(\d+),\s+)?(?:to-chk|ir-chk)=(\d+)\/(\d+)\))?/

const OPENRSYNC_RE =
  /^\s*(\d+)\s+(\d{1,3})%\s+(?:([\d.]+)(KB|MB|GB|TB)\/s\s+)?\d+:\d{2}:\d{2}(?:\s+\(xfer#(\d+),\s+to-check=(\d+)\/(\d+)\))?\s*$/

function parseCount(raw: string): number {
  return Number.parseInt(raw.replace(/,/g, ''), 10)
}

function parseGnuLine(line: string): RsyncProgress | null {
  const gnu = PROGRESS_RE.exec(line)
  if (!gnu) return null
  const [, bytesRaw, percentRaw, speedRaw, speedUnit, xfrRaw, toCheckRaw, totalRaw] = gnu
  const multiplier = UNITS[speedUnit ?? ''] ?? 1
  return {
    bytes: parseCount(bytesRaw),
    percent: Number.parseInt(percentRaw, 10),
    speedBytesPerSec: Math.round(Number.parseFloat(speedRaw) * multiplier),
    transferredFiles: xfrRaw ? Number.parseInt(xfrRaw, 10) : null,
    toCheck: toCheckRaw ? Number.parseInt(toCheckRaw, 10) : null,
    totalChecks: totalRaw ? Number.parseInt(totalRaw, 10) : null
  }
}

function parseOpenrsyncLine(line: string): RsyncProgress | null {
  const openrsync = OPENRSYNC_RE.exec(line)
  if (!openrsync) return null
  const [, bytesRaw, percentRaw, speedRaw, speedUnit, xferRaw, toCheckRaw, totalRaw] = openrsync
  return {
    bytes: parseCount(bytesRaw),
    percent: Number.parseInt(percentRaw, 10),
    speedBytesPerSec: speedRaw
      ? Math.round(Number.parseFloat(speedRaw) * (OPENRSYNC_UNITS[speedUnit ?? ''] ?? 1))
      : null,
    transferredFiles: xferRaw ? Number.parseInt(xferRaw, 10) : null,
    toCheck: toCheckRaw ? Number.parseInt(toCheckRaw, 10) : null,
    totalChecks: totalRaw ? Number.parseInt(totalRaw, 10) : null,
    finished: xferRaw !== undefined
  }
}

export function parseProgressLine(line: string, dialect: RsyncDialect = 'gnu'): RsyncProgress | null {
  if (dialect === 'openrsync') {
    const openrsync = parseOpenrsyncLine(line)
    if (openrsync) return openrsync
  }
  return parseGnuLine(line) ?? parseOpenrsyncLine(line)
}

export function isProgressLine(line: string): boolean {
  return parseProgressLine(line) !== null
}

export function normalizeNameLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (/^sending incremental file list$/.test(trimmed)) return null
  if (/^created directory /.test(trimmed)) return null
  if (/^\.\/$/.test(trimmed)) return null
  return trimmed.replace(/\/+$/, '')
}
