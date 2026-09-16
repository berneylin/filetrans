import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}

export function Modal({ title, onClose, children, width = 480 }: Props) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onMouseDown={onClose}
    >
      <div
        className="rounded border border-gray-300 bg-white shadow-xl"
        style={{ width }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 bg-gray-100 px-3 py-2 text-[13px] font-semibold">
          {title}
          <button
            className="text-gray-400 hover:text-gray-600"
            title="关闭"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  )
}
