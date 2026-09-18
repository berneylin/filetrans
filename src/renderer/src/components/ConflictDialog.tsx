import { useEffect, useState } from 'react'
import type { ConflictResolution } from '@shared/types'
import { useSettings } from '../stores/settings'
import { useTransfers } from '../stores/transfers'
import { btn, btnPrimary } from '../utils/styles'
import { Modal } from './Modal'

const MAX_ITEMS = 8

export function ConflictDialog() {
  const conflicts = useTransfers((state) => state.conflicts)
  const resolveConflict = useTransfers((state) => state.resolveConflict)
  const resumeEnabled = useSettings((state) => state.resume)
  const [resolution, setResolution] = useState<Exclude<ConflictResolution, 'cancel'>>(
    resumeEnabled ? 'resume' : 'overwrite'
  )
  const conflict = conflicts[0] ?? null

  useEffect(() => {
    setResolution(resumeEnabled ? 'resume' : 'overwrite')
  }, [conflict, resumeEnabled])

  if (!conflict) return null

  return (
    <Modal
      title="目标文件已存在"
      onClose={() => void resolveConflict('cancel')}
      width={560}
      dismissible={false}
    >
      <div className="text-gray-700">
        以下 {conflict.items.length} 个目标位置已存在同名文件：
        {conflicts.length > 1 && <span>（还有 {conflicts.length - 1} 个传输等待处理）</span>}
      </div>
      <div className="mt-2 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-[12px]">
        {conflict.items.slice(0, MAX_ITEMS).map((item) => (
          <div key={item.targetPath} className="truncate" title={item.targetPath}>
            <span className="mr-1 text-gray-500">
              {item.type === 'directory' ? '[目录]' : item.type === 'symlink' ? '[链接]' : '[文件]'}
            </span>
            {item.targetPath}
          </div>
        ))}
        {conflict.items.length > MAX_ITEMS && (
          <div className="text-gray-500">…等共 {conflict.items.length} 项</div>
        )}
      </div>
      {resolution === 'overwrite' && conflict.items.some((item) => item.type === 'directory') && (
        <div className="mt-2 text-[12px] text-red-600">
          覆盖将递归删除远程同名目录及其全部内容，请确认。
        </div>
      )}
      <div className="mt-3 space-y-1">
        {resumeEnabled && (
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={resolution === 'resume'}
              onChange={() => setResolution('resume')}
            />
            续传（从断点继续，已完整的文件跳过）
          </label>
        )}
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={resolution === 'overwrite'}
            onChange={() => setResolution('overwrite')}
          />
          覆盖已有文件
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={resolution === 'skip'}
            onChange={() => setResolution('skip')}
          />
          跳过这些文件
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn} onClick={() => void resolveConflict('cancel')}>
          取消传输
        </button>
        <button className={btnPrimary} onClick={() => void resolveConflict(resolution)}>
          确定
        </button>
      </div>
    </Modal>
  )
}
