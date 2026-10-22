import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { isTopModal, popModal, pushModal } from '../utils/modalStack'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  dismissible?: boolean
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  const nodes = panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  return Array.from(nodes)
}

export function Modal({ title, onClose, children, width = 480, dismissible = true }: Props) {
  const pressedOnBackdrop = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<symbol | null>(null)

  useEffect(() => {
    const token = pushModal()
    tokenRef.current = token
    const panel = panelRef.current
    const previous = document.activeElement as HTMLElement | null
    if (panel) {
      const scope = bodyRef.current ?? panel
      const first = focusableElements(scope)[0] ?? panel
      first.focus()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panel || !isTopModal(token)) return
      const focusables = focusableElements(panel)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !(active instanceof Node) || !panel.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !(active instanceof Node) || !panel.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      popModal(token)
      tokenRef.current = null
      previous?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (!dismissible) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const token = tokenRef.current
      if (token && isTopModal(token)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissible, onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex animate-fade-in items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget
      }}
      onMouseUp={(event) => {
        const startedOutside = pressedOnBackdrop.current
        pressedOnBackdrop.current = false
        if (!dismissible || !startedOutside) return
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[90vh] max-w-[calc(100vw-32px)] animate-pop-in flex-col overflow-hidden rounded-xl border border-ui-200 bg-ui-0 shadow-2xl shadow-black/20 outline-none"
        style={{ width }}
        onMouseDown={(event) => {
          event.stopPropagation()
          pressedOnBackdrop.current = false
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ui-100 px-4 py-2.5">
          <span className="text-[14px] font-semibold text-ui-800">{title}</span>
          <button
            className="-mr-1.5 flex h-7 w-7 items-center justify-center rounded-md text-ui-400 transition-colors hover:bg-ui-100 hover:text-ui-700"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div ref={bodyRef} className="min-h-0 overflow-auto p-4 outline-none">
          {children}
        </div>
      </div>
    </div>
  )
}
