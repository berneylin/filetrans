import { useTabs } from '../stores/tabs'

export function StatusBar() {
  const tab = useTabs((state) => state.tabs.find((item) => item.id === state.activeId) ?? null)

  const dotClass =
    tab?.status === 'connected'
      ? 'bg-green-500'
      : tab?.status === 'connecting'
        ? 'bg-amber-500'
        : 'bg-gray-400'

  const text = !tab
    ? '未连接'
    : tab.status === 'connected' && tab.session
      ? `已连接 ${tab.session.username}@${tab.session.host}:${tab.session.port}`
      : tab.status === 'connecting'
        ? `正在连接 ${tab.title}…`
        : tab.error
          ? `未连接（${tab.error}）`
          : '未连接'

  return (
    <div className="flex items-center gap-3 border-t border-gray-300 bg-gray-100 px-2 py-0.5 text-gray-600">
      <span className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
        {text}
      </span>
      <span className="ml-auto text-gray-400">FileTrans 0.1.0</span>
    </div>
  )
}
