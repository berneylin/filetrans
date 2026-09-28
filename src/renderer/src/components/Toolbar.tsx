import { useEffect, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { useSites } from '../stores/sites'
import { useTabs } from '../stores/tabs'
import { useUi } from '../stores/ui'
import { errorMessage } from '../utils/errors'
import { btn, btnPrimary, input } from '../utils/styles'

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
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-300 bg-gradient-to-b from-white to-gray-100 px-2 py-1">
      <span className="text-gray-600">站点:</span>
      <select
        className={`${input} w-56`}
        value={selectedSite}
        onChange={(event) => setSelectedSite(event.target.value)}
      >
        <option value="">— 选择站点 —</option>
        {sites.map((site) => (
          <option key={site.id} value={site.id}>
            {site.name} ({site.username}@{site.host})
          </option>
        ))}
      </select>
      <button
        className={btnPrimary}
        disabled={!selectedSite || busy}
        onClick={() => void handleConnect()}
      >
        {busy ? '连接中…' : '新建连接'}
      </button>
      <button className={btn} onClick={() => setSiteManagerOpen(true)}>
        站点管理…
      </button>
      <button className={btn} onClick={() => setSyncDialogOpen(true)}>
        <ArrowLeftRight size={12} className="mr-1 inline" />
        同步…
      </button>
      {error && <span className="truncate text-red-600">{error}</span>}
    </div>
  )
}
