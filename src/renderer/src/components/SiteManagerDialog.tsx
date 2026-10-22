import { useEffect, useRef, useState } from 'react'
import type { SiteConfig, SiteInput } from '@shared/types'
import { useSites } from '../stores/sites'
import { useTabs } from '../stores/tabs'
import { useUi } from '../stores/ui'
import { errorMessage } from '../utils/errors'
import { nextSiteName } from '../utils/sites'
import { Plus, Server } from 'lucide-react'
import { btn, btnDanger, btnPrimary, dialogInput } from '../utils/styles'
import { Modal } from './Modal'

interface FormState {
  id?: string
  name: string
  host: string
  port: string
  username: string
  authType: 'password' | 'key'
  password: string
  keyPath: string
  passphrase: string
  remotePath: string
  rememberSecret: boolean
}

function emptyForm(): FormState {
  return {
    id: undefined,
    name: '',
    host: '',
    port: '22',
    username: '',
    authType: 'password',
    password: '',
    keyPath: '',
    passphrase: '',
    remotePath: '',
    rememberSecret: false
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[90px_1fr] items-center gap-2">
      <span className="text-right text-ui-500">{label}</span>
      {children}
    </label>
  )
}

export function SiteManagerDialog() {
  const open = useUi((state) => state.siteManagerOpen)
  const setOpen = useUi((state) => state.setSiteManagerOpen)
  const sites = useSites((state) => state.sites)
  const loadSites = useSites((state) => state.loadSites)
  const openSite = useTabs((state) => state.openSite)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  const [dataIssues, setDataIssues] = useState<string[]>([])
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    void loadSites()
    void window.api.sites
      .security()
      .then((result) => setEncryptionAvailable(result.encryptionAvailable))
      .catch(() => setEncryptionAvailable(true))
    void window.api.sites
      .dataIssues()
      .then((issues) => setDataIssues(issues))
      .catch(() => setDataIssues([]))
    setError(null)
  }, [open, loadSites])

  if (!open) return null

  const patch = (values: Partial<FormState>): void => setForm((state) => ({ ...state, ...values }))

  const selectSite = (site: SiteConfig): void => {
    setForm({
      id: site.id,
      name: site.name,
      host: site.host,
      port: String(site.port),
      username: site.username,
      authType: site.authType,
      password: '',
      keyPath: site.keyPath ?? '',
      passphrase: '',
      remotePath: site.remotePath ?? '',
      rememberSecret: site.rememberSecret
    })
    setError(null)
  }

  const handleNew = (): void => {
    setError(null)
    setForm({ ...emptyForm(), name: nextSiteName(sites) })
    requestAnimationFrame(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    })
  }

  const buildInput = (): SiteInput | null => {    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError('请填写站点名称、主机和用户名')
      return null
    }
    const input: SiteInput = {
      id: form.id,
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port) || 22,
      username: form.username.trim(),
      authType: form.authType,
      keyPath: form.authType === 'key' ? form.keyPath.trim() || undefined : undefined,
      passphrase: form.authType === 'key' ? form.passphrase || undefined : undefined,
      password: form.authType === 'password' ? form.password || undefined : undefined,
      remotePath: form.remotePath.trim() || undefined,
      rememberSecret: form.rememberSecret && encryptionAvailable
    }
    return input
  }

  const save = async (): Promise<SiteConfig | null> => {
    const input = buildInput()
    if (!input) return null
    const saved = await window.api.sites.save(input)
    await loadSites()
    setForm((state) => ({ ...state, id: saved.id, password: '', passphrase: '' }))
    return saved
  }

  const validateKey = async (): Promise<boolean> => {
    if (form.authType !== 'key' || !form.keyPath.trim()) return true
    try {
      const result = await window.api.sftp.checkKey(
        form.keyPath.trim(),
        form.passphrase || undefined
      )
      if (!result.valid) {
        setError(result.message ?? '私钥文件无效')
        return false
      }
    } catch (err) {
      setError(errorMessage(err))
      return false
    }
    return true
  }

  const handleSave = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!(await validateKey())) return
      await save()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!form.id) return
    if (!window.confirm(`确定删除站点“${form.name}”吗？`)) return
    setBusy(true)
    setError(null)
    try {
      await window.api.sites.remove(form.id)
      await loadSites()
      setForm(emptyForm())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const handleConnect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!(await validateKey())) return
      const saved = await save()
      if (!saved) return
      const hasTypedSecret = Boolean(form.password) || Boolean(form.passphrase)
      const overrides = hasTypedSecret
        ? {
            password: form.authType === 'password' ? form.password || undefined : undefined,
            passphrase: form.authType === 'key' ? form.passphrase || undefined : undefined
          }
        : undefined
      await openSite(saved.id, overrides)
      setOpen(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const browseKey = async (): Promise<void> => {
    const picked = await window.api.pickFile({ title: '选择私钥文件' })
    if (!picked) return
    patch({ keyPath: picked })
    try {
      const result = await window.api.sftp.checkKey(picked, form.passphrase || undefined)
      if (!result.valid) setError(result.message ?? '私钥文件无效')
      else setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Modal title="站点管理器" onClose={() => setOpen(false)} width={700}>
      <div className="flex gap-3">
        <div className="flex w-56 flex-col">
          <div className="mb-1.5 text-[12px] font-medium text-ui-500">站点列表</div>
          <div className="max-h-80 min-h-40 flex-1 space-y-0.5 overflow-auto rounded-lg border border-ui-200 bg-ui-50/60 p-1">
            {sites.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-ui-400">
                <Server size={20} strokeWidth={1.5} className="text-ui-300" />
                暂无站点
              </div>
            ) : (
              sites.map((site) => (
                <button
                  key={site.id}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                    form.id === site.id
                      ? 'bg-ui-0 text-blue-700 dark:text-blue-300 shadow-sm ring-1 ring-blue-200 dark:ring-blue-500/40'
                      : 'text-ui-700 hover:bg-ui-0'
                  }`}
                  onClick={() => selectSite(site)}
                  title={`${site.username}@${site.host}:${site.port}`}
                >
                  <Server
                    size={14}
                    className={`shrink-0 ${form.id === site.id ? 'text-blue-500' : 'text-ui-400'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{site.name}</span>
                    <span className="block truncate text-[11px] text-ui-400">
                      {site.username}@{site.host}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <button className={`${btn} mt-2`} disabled={busy} onClick={handleNew}>
            <Plus size={13} className="text-ui-500" />
            新建站点
          </button>
        </div>

        <div className="flex-1 space-y-2.5 border-l border-ui-100 pl-4">
          <Field label="名称">
            <input
              ref={nameInputRef}
              className={dialogInput}
              value={form.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-[90px_minmax(0,1fr)_auto_80px] items-center gap-2">
            <span className="text-right text-ui-500">主机</span>
            <input
              className={dialogInput}
              value={form.host}
              onChange={(event) => patch({ host: event.target.value })}
            />
            <span className="text-right text-ui-500">端口</span>
            <input
              className={dialogInput}
              value={form.port}
              onChange={(event) => patch({ port: event.target.value })}
            />
          </div>
          <Field label="用户名">
            <input
              className={dialogInput}
              value={form.username}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </Field>
          <Field label="认证方式">
            <select
              className={dialogInput}
              value={form.authType}
              onChange={(event) => patch({ authType: event.target.value as FormState['authType'] })}
            >
              <option value="password">密码</option>
              <option value="key">密钥文件</option>
            </select>
          </Field>
          {form.authType === 'password' ? (
            <Field label="密码">
              <input
                className={dialogInput}
                type="password"
                placeholder={form.id ? '留空表示不修改已保存的密码' : ''}
                value={form.password}
                onChange={(event) => patch({ password: event.target.value })}
              />
            </Field>
          ) : (
            <>
              <Field label="私钥文件">
                <div className="flex gap-1">
                  <input
                    className={dialogInput}
                    value={form.keyPath}
                    onChange={(event) => patch({ keyPath: event.target.value })}
                  />
                  <button
                    className={`${btn} shrink-0 whitespace-nowrap`}
                    onClick={() => void browseKey()}
                  >
                    浏览…
                  </button>
                </div>
              </Field>
              <Field label="密钥口令">
                <input
                  className={dialogInput}
                  type="password"
                  placeholder={form.id ? '留空表示不修改已保存的口令' : ''}
                  value={form.passphrase}
                  onChange={(event) => patch({ passphrase: event.target.value })}
                />
              </Field>
            </>
          )}
          <Field label="默认路径">
            <input
              className={dialogInput}
              placeholder="连接后打开的远程目录（可留空）"
              value={form.remotePath}
              onChange={(event) => patch({ remotePath: event.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 pl-[98px] text-ui-700">
            <input
              type="checkbox"
              checked={form.rememberSecret && encryptionAvailable}
              disabled={!encryptionAvailable}
              onChange={(event) => patch({ rememberSecret: event.target.checked })}
            />
            记住密码/口令（使用系统密钥环加密）
          </label>
          {!encryptionAvailable && (
            <div className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
              当前系统没有可用的密钥环，无法加密保存密码/口令，请取消勾选“记住密码”。
            </div>
          )}
          {dataIssues.map((issue) => (
            <div key={issue} className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
              {issue}
            </div>
          ))}
          {error && (
            <div className="rounded-md bg-red-50 dark:bg-red-500/10 px-3 py-2 text-red-600 dark:text-red-400">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            {form.id && (
              <button className={btnDanger} disabled={busy} onClick={() => void handleDelete()}>
                删除
              </button>
            )}
            <button className={btn} disabled={busy} onClick={() => void handleSave()}>
              保存
            </button>
            <button className={btnPrimary} disabled={busy} onClick={() => void handleConnect()}>
              保存并连接
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
