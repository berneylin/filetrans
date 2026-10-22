import { useTabs } from '../stores/tabs'

export function StatusBar() {
  const tab = useTabs((state) => state.tabs.find((item) => item.id === state.activeId) ?? null)

  const dotClass =
    tab?.status === 'connected'
      ? 'bg-emerald-500 ring-2 ring-emerald-500/20'
      : tab?.status === 'connecting'
        ? 'bg-amber-500 animate-pulse'
        : 'bg-ui-300'

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
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-ui-200 bg-ui-0 px-3 text-[11.5px] text-ui-500">
      <span className="flex min-w-0 items-center gap-2">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
        <span className="truncate">{text}</span>
      </span>
      <span className="ml-auto shrink-0 text-ui-400">FileTrans 0.1.0</span>
    </div>
  )
}
