import { useEffect } from 'react'
import { useUi } from '../stores/ui'

export function ContextMenu() {
  const menu = useUi((state) => state.menu)
  const closeMenu = useUi((state) => state.closeMenu)

  useEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, closeMenu])

  if (!menu) return null

  const left = Math.min(menu.x, window.innerWidth - 200)
  const maxTop = window.innerHeight - menu.items.length * 26 - 16
  const top = Math.max(4, Math.min(menu.y, maxTop))

  return (
    <div
      className="fixed inset-0 z-50"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeMenu()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        closeMenu()
      }}
    >
      <div
        className="absolute min-w-[180px] animate-fade-in rounded-lg border border-ui-200 bg-ui-0 p-1 shadow-xl shadow-black/10"
        style={{ left, top }}
      >
        {menu.items.map((item, index) =>
          item.separator ? (
            <div key={index} className="mx-1 my-1 h-px bg-ui-100" />
          ) : (
            <button
              key={index}
              disabled={item.disabled}
              className={`block w-full rounded-md px-2.5 py-1 text-left transition-colors ${
                item.disabled
                  ? 'cursor-not-allowed text-ui-300'
                  : item.danger
                    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10'
                    : 'text-ui-700 hover:bg-blue-600 hover:text-white'
              }`}
              onClick={() => {
                closeMenu()
                item.onClick?.()
              }}
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </div>
  )
}
