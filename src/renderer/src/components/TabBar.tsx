import { Plus, X } from 'lucide-react'
import { useTabs, type TabState } from '../stores/tabs'
import { useUi } from '../stores/ui'

function statusColor(tab: TabState): string {
  if (tab.status === 'connected') return 'bg-emerald-500'
  if (tab.status === 'connecting') return 'bg-amber-500 animate-pulse'
  return 'bg-ui-300'
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
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            className={`group flex h-7 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-md border pr-1 pl-2.5 transition-colors ${
              active
                ? 'border-ui-200 bg-ui-0 font-medium text-ui-800 shadow-sm'
                : 'border-transparent text-ui-600 hover:bg-ui-0/60 hover:text-ui-800'
            }`}
            title={tabTitle(tab)}
            onClick={() => setActive(tab.id)}
          >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusColor(tab)}`} />
            <span className="truncate">{tab.title}</span>
            <button
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-ui-400 hover:bg-ui-200 hover:text-ui-700 ${
                active ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
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
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ui-500 transition-colors hover:bg-ui-0 hover:text-blue-600 dark:hover:text-blue-400"
        title="新建连接（站点管理）"
        onClick={() => setSiteManagerOpen(true)}
      >
        <Plus size={15} />
      </button>
      {tabs.length === 0 && (
        <span className="ml-1 text-[12px] text-ui-400">从上方选择站点后点击“新建连接”</span>
      )}
    </div>
  )
}
