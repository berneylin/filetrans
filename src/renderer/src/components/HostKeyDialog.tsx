import { useUi } from '../stores/ui'
import { ShieldAlert, ShieldQuestion } from 'lucide-react'
import { btn, btnPrimary } from '../utils/styles'
import { Modal } from './Modal'

export function HostKeyDialog() {
  const prompts = useUi((state) => state.hostKeys)
  const removeHostKey = useUi((state) => state.removeHostKey)

  const prompt = prompts[0] ?? null
  if (!prompt) return null
  const { info, promptId } = prompt

  const respond = (accept: boolean, remember: boolean): void => {
    removeHostKey(promptId)
    void window.api.hostkey.respond(promptId, accept, remember)
  }

  return (
    <Modal title="未知主机密钥" onClose={() => respond(false, false)} width={520} dismissible={false}>
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              info.known === 'changed' ? 'bg-red-50 dark:bg-red-500/10 text-red-500' : 'bg-amber-50 dark:bg-amber-500/10 text-amber-500'
            }`}
          >
            {info.known === 'changed' ? <ShieldAlert size={18} /> : <ShieldQuestion size={18} />}
          </div>
          <div className="pt-2 text-ui-700">
            无法确认主机 <span className="font-semibold">{info.host}:{info.port}</span> 的身份。
          </div>
        </div>
        <div className="rounded-md border border-ui-200 bg-ui-50 px-3 py-2 font-mono text-[12px] break-all text-ui-700 select-text">
          {info.fingerprint}
        </div>
        {info.known === 'changed' && (
          <div className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
            警告：该主机密钥与之前保存的不一致，可能存在中间人攻击！
            {info.previousFingerprint && (
              <div className="mt-1 font-mono text-[11px] break-all">
                之前: {info.previousFingerprint}
              </div>
            )}
          </div>
        )}
        <div className="text-[12px] text-ui-500">
          请确认该指纹与服务器管理员提供的一致。信任后将保存在本机。
          {prompts.length > 1 && <span>（还有 {prompts.length - 1} 个连接等待确认）</span>}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn} onClick={() => respond(false, false)}>
          取消
        </button>
        <button className={btn} onClick={() => respond(true, false)}>
          仅本次信任
        </button>
        <button className={btnPrimary} onClick={() => respond(true, true)}>
          信任并记住
        </button>
      </div>
    </Modal>
  )
}
