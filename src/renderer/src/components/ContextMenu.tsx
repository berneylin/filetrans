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
        className="absolute min-w-[170px] rounded border border-gray-300 bg-white py-1 shadow-lg"
        style={{ left, top }}
      >
        {menu.items.map((item, index) =>
          item.separator ? (
            <div key={index} className="my-1 border-t border-gray-200" />
          ) : (
            <button
              key={index}
              disabled={item.disabled}
              className={`block w-full px-3 py-1 text-left ${
                item.disabled
                  ? 'cursor-not-allowed text-gray-400'
                  : `hover:bg-blue-600 hover:text-white ${
                      item.danger ? 'text-red-600 hover:text-white' : ''
                    }`
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
