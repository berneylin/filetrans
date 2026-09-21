export function validateDirectoryPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed.includes('\0')) throw new Error('无效的目录路径')
  return trimmed
}

export function posixNormalize(input: string): string {
  if (!input) return '.'
  const absolute = input.startsWith('/')
  const out: string[] = []
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
    } else {
      out.push(seg)
    }
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined || '.'
}

export function posixJoin(...parts: string[]): string {
  return posixNormalize(parts.filter((p) => p.length > 0).join('/'))
}

export function posixDirname(input: string): string {
  const normalized = posixNormalize(input)
  const idx = normalized.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return normalized.slice(0, idx)
}

export function posixBasename(input: string): string {
  const normalized = posixNormalize(input)
  if (normalized === '/') return '/'
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? normalized : normalized.slice(idx + 1)
}

export function posixParent(input: string): string | null {
  const normalized = posixNormalize(input)
  if (normalized === '/') return null
  const parent = posixDirname(normalized)
  return parent === normalized ? null : parent
}

export function posixRelative(from: string, to: string): string {
  const fromParts = posixNormalize(from).split('/').filter(Boolean)
  const toParts = posixNormalize(to).split('/').filter(Boolean)
  const absoluteFrom = posixNormalize(from).startsWith('/')
  const absoluteTo = posixNormalize(to).startsWith('/')
  if (absoluteFrom !== absoluteTo) return posixNormalize(to)
  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }
  const parts = [
    ...Array.from({ length: fromParts.length - common }, () => '..'),
    ...toParts.slice(common)
  ]
  return parts.length > 0 ? parts.join('/') : '.'
}

export function escapesParent(parent: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('/')) return false
  const parentNormalized = posixNormalize(parent)
  const resolved = posixJoin(parentNormalized, trimmed)
  const prefix = parentNormalized.endsWith('/') ? parentNormalized : `${parentNormalized}/`
  return resolved !== parentNormalized && !resolved.startsWith(prefix)
}

export function findBannedDir(candidate: string, banned: readonly string[]): string | null {
  const normalized = posixNormalize(candidate.trim())
  for (const entry of banned) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (posixNormalize(trimmed) === normalized) return trimmed
  }
  return null
}
