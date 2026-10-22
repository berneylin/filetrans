import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileVideoCamera,
  type LucideIcon
} from 'lucide-react'

export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'script'
  | 'data'
  | 'config'
  | 'sheet'
  | 'pdf'
  | 'document'
  | 'text'
  | 'key'
  | 'file'

const EXTENSIONS: Record<Exclude<FileKind, 'file'>, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', '7z', 'rar', 'zst', 'deb', 'rpm', 'jar', 'appimage', 'dmg', 'iso'],
  code: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'rb', 'php', 'swift', 'cs', 'lua', 'vue', 'css', 'scss', 'html', 'sql'],
  script: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat'],
  data: ['json', 'jsonl', 'yaml', 'yml', 'toml', 'xml'],
  config: ['ini', 'conf', 'cfg', 'env', 'properties', 'service'],
  sheet: ['csv', 'tsv', 'xls', 'xlsx', 'ods'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx'],
  text: ['txt', 'md', 'log', 'rst'],
  key: ['pem', 'key', 'pub', 'crt', 'cer', 'p12', 'pfx']
}

const KIND_BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(EXTENSIONS).flatMap(([kind, exts]) =>
    exts.map((ext) => [ext, kind as FileKind] as const)
  )
)

export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'file'
  return KIND_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? 'file'
}

export const FILE_ICONS: Record<FileKind, { icon: LucideIcon; className: string }> = {
  image: { icon: FileImage, className: 'text-violet-500' },
  video: { icon: FileVideoCamera, className: 'text-rose-500' },
  audio: { icon: FileMusic, className: 'text-pink-500' },
  archive: { icon: FileArchive, className: 'text-amber-600 dark:text-amber-400' },
  code: { icon: FileCode, className: 'text-sky-600' },
  script: { icon: FileTerminal, className: 'text-emerald-600 dark:text-emerald-400' },
  data: { icon: FileBraces, className: 'text-teal-600' },
  config: { icon: FileCog, className: 'text-ui-500' },
  sheet: { icon: FileSpreadsheet, className: 'text-green-600 dark:text-green-400' },
  pdf: { icon: FileText, className: 'text-red-500' },
  document: { icon: FileText, className: 'text-blue-600 dark:text-blue-400' },
  text: { icon: FileText, className: 'text-ui-500' },
  key: { icon: FileKey, className: 'text-amber-500' },
  file: { icon: File, className: 'text-ui-400' }
}
