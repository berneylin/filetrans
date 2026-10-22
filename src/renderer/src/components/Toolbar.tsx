import { useEffect, useState } from 'react'
import {
  ArrowLeftRight,
  FolderSync,
  Monitor,
  Moon,
  Plug,
  Server,
  Sun,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { useSites } from '../stores/sites'
import { useTabs } from '../stores/tabs'
import { useTheme } from '../stores/theme'
import { useUi } from '../stores/ui'
import { errorMessage } from '../utils/errors'
import { btn, btnPrimary, input } from '../utils/styles'

const THEME_OPTIONS: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
  { mode: 'system', label: '跟随系统', icon: Monitor },
  { mode: 'light', label: '浅色', icon: Sun },
  { mode: 'dark', label: '深色', icon: Moon }
]

function ThemeSwitch() {
  const mode = useTheme((state) => state.mode)
  const setMode = useTheme((state) => state.setMode)
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-ui-100 p-0.5" role="radiogroup" aria-label="主题">
      {THEME_OPTIONS.map(({ mode: option, label, icon: Icon }) => (
        <button
          key={option}
          role="radio"
          aria-checked={mode === option}
          title={`主题：${label}`}
          className={`flex h-6 w-7 items-center justify-center rounded-md transition-colors ${
            mode === option
              ? 'bg-ui-0 text-ui-800 shadow-sm'
              : 'text-ui-400 hover:text-ui-700'
          }`}
          onClick={() => setMode(option)}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  )
}

export function Toolbar() {
  const sites = useSites((state) => state.sites)
  const openSite = useTabs((state) => state.openSite)
  const setSiteManagerOpen = useUi((state) => state.setSiteManagerOpen)
  const setSyncDialogOpen = useUi((state) => state.setSyncDialogOpen)
  const [selectedSite, setSelectedSite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (selectedSite && !sites.some((site) => site.id === selectedSite)) {
      setSelectedSite('')
    }
  }, [sites, selectedSite])

  const handleConnect = async (): Promise<void> => {
    if (!selectedSite) return
    setBusy(true)
    setError(null)
    try {
      await openSite(selectedSite)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ui-200 bg-ui-0 px-3">
      <div className="mr-2 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm">
          <ArrowLeftRight size={15} strokeWidth={2.25} />
        </div>
        <span className="text-[14px] font-semibold tracking-tight text-ui-800">FileTrans</span>
      </div>
      <div className="h-5 w-px bg-ui-200" />
      <div className="relative">
        <Server
          size={13}
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ui-400"
        />
        <select
          className={`${input} w-64 pl-7`}
          title="站点"
          value={selectedSite}
          onChange={(event) => setSelectedSite(event.target.value)}
        >
          <option value="">选择站点…</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name} ({site.username}@{site.host})
            </option>
          ))}
        </select>
      </div>
      <button
        className={btnPrimary}
        disabled={!selectedSite || busy}
        onClick={() => void handleConnect()}
      >
        <Plug size={13} />
        {busy ? '连接中…' : '新建连接'}
      </button>
      <button className={btn} onClick={() => setSiteManagerOpen(true)}>
        <Server size={13} className="text-ui-500" />
        站点管理…
      </button>
      <button className={btn} onClick={() => setSyncDialogOpen(true)}>
        <FolderSync size={13} className="text-ui-500" />
        同步…
      </button>
      {error && (
        <span
          className="flex min-w-0 items-center gap-1 truncate rounded-md bg-red-50 dark:bg-red-500/10 px-2 py-1 text-[12px] text-red-600 dark:text-red-400"
          title={error}
        >
          <TriangleAlert size={13} className="shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      )}
      <div className="ml-auto pl-2">
        <ThemeSwitch />
      </div>
    </div>
  )
}
