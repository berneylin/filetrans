import { Plus, X } from 'lucide-react'
import { useTabs, type TabState } from '../stores/tabs'
import { useUi } from '../stores/ui'

function statusColor(tab: TabState): string {
  if (tab.status === 'connected') return 'bg-green-500'
  if (tab.status === 'connecting') return 'bg-amber-500'
  return 'bg-gray-400'
}

function tabTitle(tab: TabState): string {
  if (tab.status === 'disconnected' && tab.error) return `${tab.title}（${tab.error}）`
  return tab.title
}

export function TabBar() {
  const tabs = useTabs((state) => state.tabs)
  const activeId = useTabs((state) => state.activeId)
  const setActive = useTabs((state) => state.setActive)
  const closeTab = useTabs((state) => state.closeTab)
  const setSiteManagerOpen = useUi((state) => state.setSiteManagerOpen)

  return (
    <div className="flex items-end gap-0.5 border-b border-gray-300 bg-gray-200 px-1 pt-1">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            className={`flex h-7 max-w-52 cursor-default items-center gap-1.5 rounded-t border border-b-0 px-2 ${
              active
                ? 'border-gray-300 bg-white text-gray-800'
                : 'border-gray-300 bg-gray-100 text-gray-600 hover:bg-gray-50'
            }`}
            title={tabTitle(tab)}
            onClick={() => setActive(tab.id)}
          >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusColor(tab)}`} />
            <span className="truncate">{tab.title}</span>
            <button
              className="shrink-0 text-gray-400 hover:text-red-600"
              title="关闭标签页"
              onClick={(event) => {
                event.stopPropagation()
                void closeTab(tab.id)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
      <button
        className="mb-0.5 ml-1 flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-white hover:text-blue-600"
        title="新建连接（站点管理）"
        onClick={() => setSiteManagerOpen(true)}
      >
        <Plus size={14} />
      </button>
      {tabs.length === 0 && (
        <span className="mb-1 ml-2 text-gray-500">从上方选择站点后点击“新建连接”</span>
      )}
    </div>
  )
}
