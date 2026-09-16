import { generateKeyPairSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPrivateKey } from '../src/main/sftp/session'

describe('checkPrivateKey', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filetrans-key-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('有效的 PKCS#1 私钥通过校验', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const file = path.join(tempDir, 'id_rsa')
    await fs.writeFile(file, privateKey)
    const result = await checkPrivateKey(file)
    expect(result.valid).toBe(true)
  })

  it('公钥文件（PEM）判定为无效', async () => {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    const file = path.join(tempDir, 'id_rsa.pub')
    await fs.writeFile(file, publicKey)
    const result = await checkPrivateKey(file)
    expect(result.valid).toBe(false)
    expect(result.message).toContain('公钥')
  })

  it('公钥文件（OpenSSH 单行格式）判定为无效', async () => {
    const file = path.join(tempDir, 'id_ed25519.pub')
    await fs.writeFile(
      file,
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPL10k2GaJh5RcmIYJ8P5b6vXqN1xT8jyZJ7examples user@host\n'
    )
    const result = await checkPrivateKey(file)
    expect(result.valid).toBe(false)
  })

  it('任意文本判定为无效', async () => {
    const file = path.join(tempDir, 'not-a-key')
    await fs.writeFile(file, 'hello world')
    const result = await checkPrivateKey(file)
    expect(result.valid).toBe(false)
  })

  it('文件不存在判定为无效', async () => {
    const result = await checkPrivateKey(path.join(tempDir, 'missing'))
    expect(result.valid).toBe(false)
    expect(result.message).toContain('无法读取')
  })
})
