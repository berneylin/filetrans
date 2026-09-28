import { describe, expect, it } from 'vitest'
import { isTopModal, popModal, pushModal } from '../../src/renderer/src/utils/modalStack'

describe('modalStack', () => {
  it('只有最后打开的弹窗位于栈顶', () => {
    const outer = pushModal()
    expect(isTopModal(outer)).toBe(true)
    const inner = pushModal()
    expect(isTopModal(inner)).toBe(true)
    expect(isTopModal(outer)).toBe(false)
    popModal(inner)
    expect(isTopModal(outer)).toBe(true)
    popModal(outer)
    expect(isTopModal(outer)).toBe(false)
  })

  it('先关闭下层弹窗不影响上层弹窗的栈顶地位', () => {
    const outer = pushModal()
    const inner = pushModal()
    popModal(outer)
    expect(isTopModal(inner)).toBe(true)
    popModal(inner)
  })
})
