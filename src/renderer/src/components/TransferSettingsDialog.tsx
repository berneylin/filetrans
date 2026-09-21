import { useState } from 'react'
import { useSettings } from '../stores/settings'
import { btn, btnPrimary, dialogInput } from '../utils/styles'
import { Modal } from './Modal'

interface Props {
  onClose: () => void
}

export function TransferSettingsDialog({ onClose }: Props) {
  const settings = useSettings()
  const [resume, setResume] = useState(settings.resume)
  const [retries, setRetries] = useState(String(settings.retries))
  const [concurrency, setConcurrency] = useState(String(settings.concurrency))
  const [preserveTimestamps, setPreserveTimestamps] = useState(settings.preserveTimestamps)
  const [preservePermissions, setPreservePermissions] = useState(settings.preservePermissions)
  const [syncBannedPaths, setSyncBannedPaths] = useState(settings.syncBannedPaths)

  const save = (): void => {
    useSettings.getState().update({
      resume,
      retries: Math.max(0, Math.min(10, Number(retries) || 0)),
      concurrency: Math.max(1, Math.min(16, Number(concurrency) || 1)),
      preserveTimestamps,
      preservePermissions,
      syncBannedPaths
    })
    onClose()
  }

  return (
    <Modal title="传输设置" onClose={onClose} width={420}>
      <div className="space-y-2">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
          <span>
            断点续传
            <span className="block text-gray-500">
              同名文件已存在时从断点继续；传输失败后自动从已写入位置重试
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={Number(retries) > 0}
            onChange={(e) => setRetries(e.target.checked ? '2' : '0')}
          />
          <span className="mr-2">失败重试次数</span>
          <input
            className={`${dialogInput} w-16`}
            value={retries}
            disabled={retries === '0'}
            onChange={(e) => setRetries(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <label className="flex items-start gap-2">
          <span>
            单文件并行下载数
            <span className="block text-gray-500">
              1-16，仅对大文件生效；1 表示关闭并行
            </span>
          </span>
          <input
            className={`${dialogInput} ml-auto w-16`}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={preserveTimestamps}
            onChange={(e) => setPreserveTimestamps(e.target.checked)}
          />
          保留修改时间
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={preservePermissions}
            onChange={(e) => setPreservePermissions(e.target.checked)}
          />
          保留权限
        </label>
        <div className="mt-4 space-y-2 border-t border-gray-200 pt-3">
          <div className="text-gray-700">目录同步 (rsync)</div>
          <label className="block">
            <span>禁用同步目录</span>
            <textarea
              className={`${dialogInput} mt-1 h-20 resize-none font-mono`}
              value={syncBannedPaths}
              onChange={(e) => setSyncBannedPaths(e.target.value)}
              placeholder="每行一个目录，如 /home/sunqy/repos"
            />
            <span className="mt-1 block text-gray-500">
              列表中的目录不能作为同步的本地目录或远程目录，路径结尾的 / 会被忽略。
            </span>
          </label>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          取消
        </button>
        <button className={btnPrimary} onClick={save}>
          保存
        </button>
      </div>
    </Modal>
  )
}
