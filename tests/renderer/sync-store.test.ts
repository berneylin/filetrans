import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncJob } from '@shared/types'
import { useSync } from '../../src/renderer/src/stores/sync'

function job(id: string, status: SyncJob['status']): SyncJob {
  return {
    id,
    direction: 'upload',
    localPath: '/l',
    remotePath: '/r',
    status,
    percent: 0,
    transferredBytes: 0,
    speed: 0,
    transferredFiles: 0,
    startedAt: 0
  }
}

describe('useSync.onSuccess', () => {
  beforeEach(() => {
    useSync.setState({ jobs: [] })
  })

  it('同步成功结束后才触发回调', () => {
    const callback = vi.fn()
    useSync.getState().onUpdate(job('a', 'running'))
    useSync.getState().onSuccess('a', callback)
    expect(callback).not.toHaveBeenCalled()
    useSync.getState().onUpdate(job('a', 'done'))
    expect(callback).toHaveBeenCalledTimes(1)
    useSync.getState().onUpdate(job('a', 'done'))
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('同步失败或取消时不触发回调', () => {
    const failed = vi.fn()
    const cancelled = vi.fn()
    useSync.getState().onSuccess('b', failed)
    useSync.getState().onSuccess('c', cancelled)
    useSync.getState().onUpdate(job('b', 'error'))
    useSync.getState().onUpdate(job('c', 'cancelled'))
    expect(failed).not.toHaveBeenCalled()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('注册时任务已成功结束则立即触发', () => {
    const callback = vi.fn()
    useSync.getState().onUpdate(job('d', 'done'))
    useSync.getState().onSuccess('d', callback)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
