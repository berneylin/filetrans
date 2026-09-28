import { useEffect, useState } from 'react'
import {
  bitsToMode,
  modeToBits,
  modeToOctal,
  octalToMode,
  type PermissionBits
} from '@shared/format'
import { applyChmod } from '../actions'
import { useUi } from '../stores/ui'
import { errorMessage } from '../utils/errors'
import { btn, btnPrimary, dialogInput } from '../utils/styles'
import { Modal } from './Modal'

type Group = 'owner' | 'group' | 'other'
type Perm = 'read' | 'write' | 'execute'

const GROUP_LABELS: Record<Group, string> = {
  owner: '所有者',
  group: '用户组',
  other: '其他用户'
}

const PERM_LABELS: Record<Perm, string> = {
  read: '读取',
  write: '写入',
  execute: '执行'
}

export function ChmodDialog() {
  const target = useUi((state) => state.chmod)
  const setChmod = useUi((state) => state.setChmod)
  const [bits, setBits] = useState<PermissionBits>(modeToBits(0o644))
  const [octal, setOctal] = useState('644')
  const [specialBits, setSpecialBits] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!target) return
    const mode = target.entries[0]?.mode ?? 0o644
    setBits(modeToBits(mode))
    setOctal(modeToOctal(mode))
    setSpecialBits(mode & 0o7000)
    setError(null)
    setBusy(false)
  }, [target])

  if (!target) return null

  const toggle = (group: Group, perm: Perm): void => {
    const next: PermissionBits = {
      ...bits,
      [group]: { ...bits[group], [perm]: !bits[group][perm] }
    }
    const mode = bitsToMode(next) | specialBits
    setBits(next)
    setOctal(modeToOctal(mode))
  }

  const onOctalChange = (value: string): void => {
    setOctal(value)
    try {
      const mode = octalToMode(value)
      setBits(modeToBits(mode))
      setSpecialBits(mode & 0o7000)
      setError(null)
    } catch {
      /* 输入过程中允许暂时无效 */
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const mode = octalToMode(octal)
      await applyChmod(target, mode)
      setChmod(null)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const name = target.entries.length === 1 ? target.entries[0].name : `${target.entries.length} 个项目`

  return (
    <Modal title="更改权限" onClose={() => setChmod(null)} width={440}>
      <div className="mb-2 text-gray-600">对象: {name}</div>
      <div className="grid grid-cols-4 gap-2">
        <div />
        {(['read', 'write', 'execute'] as Perm[]).map((perm) => (
          <div key={perm} className="text-center text-gray-500">
            {PERM_LABELS[perm]}
          </div>
        ))}
        {(['owner', 'group', 'other'] as Group[]).map((group) => (
          <div key={group} className="contents">
            <div className="text-gray-600">{GROUP_LABELS[group]}</div>
            {(['read', 'write', 'execute'] as Perm[]).map((perm) => (
              <div key={perm} className="flex justify-center">
                <input
                  type="checkbox"
                  checked={bits[group][perm]}
                  onChange={() => toggle(group, perm)}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <label className="text-gray-600">八进制</label>
        <input
          className={`${dialogInput} w-24 font-mono`}
          value={octal}
          onChange={(event) => onOctalChange(event.target.value)}
        />
      </div>
      {error && <div className="mt-2 text-red-600">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button className={btn} onClick={() => setChmod(null)}>
          取消
        </button>
        <button className={btnPrimary} disabled={busy} onClick={() => void apply()}>
          应用
        </button>
      </div>
    </Modal>
  )
}
