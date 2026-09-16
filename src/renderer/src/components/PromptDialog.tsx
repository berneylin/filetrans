import { useEffect, useState } from 'react'
import { useUi } from '../stores/ui'
import { errorMessage } from '../utils/errors'
import { btn, btnPrimary, dialogInput } from '../utils/styles'
import { Modal } from './Modal'

export function PromptDialog() {
  const prompt = useUi((state) => state.prompt)
  const closePrompt = useUi((state) => state.closePrompt)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(prompt?.initial ?? '')
    setError(null)
    setBusy(false)
  }, [prompt])

  if (!prompt) return null

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await prompt.onConfirm(value)
      closePrompt()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={prompt.title} onClose={closePrompt} width={380}>
      <label className="mb-1 block text-gray-600">{prompt.label}</label>
      <input
        autoFocus
        className={dialogInput}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
          if (event.key === 'Escape') closePrompt()
        }}
      />
      {error && <div className="mt-2 text-red-600">{error}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button className={btn} onClick={closePrompt}>
          取消
        </button>
        <button className={btnPrimary} disabled={busy} onClick={() => void submit()}>
          {prompt.confirmText ?? '确定'}
        </button>
      </div>
    </Modal>
  )
}
