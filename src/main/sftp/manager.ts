import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { ConnectParams, HostKeyInfo, SessionInfo } from '@shared/types'
import { getKnownHost, trustKnownHost } from '../storage'
import { SftpSession } from './session'

interface PendingPrompt {
  resolve: (value: { accept: boolean; remember: boolean }) => void
}

export class SessionManager {
  private sessions = new Map<string, SftpSession>()
  private pending = new Map<string, PendingPrompt>()
  private promptIdBySession = new Map<string, string>()
  private sessionByPromptId = new Map<string, string>()
  private closeListeners = new Set<(sessionId: string) => void>()

  constructor(private getWebContents: () => WebContents | null) {}

  get(sessionId: string): SftpSession {
    const session = this.sessions.get(sessionId)
    if (!session || !session.connected) throw new Error('会话不存在或已断开')
    return session
  }

  findByParams(params: ConnectParams): SftpSession | undefined {
    for (const session of this.sessions.values()) {
      if (!session.connected) continue
      if (
        session.params.host === params.host &&
        session.params.port === params.port &&
        session.params.username === params.username
      ) {
        return session
      }
    }
    return undefined
  }

  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  private expireHostKeyPrompt(sessionId: string): void {
    const promptId = this.promptIdBySession.get(sessionId)
    if (!promptId) return
    this.promptIdBySession.delete(sessionId)
    this.sessionByPromptId.delete(promptId)
    const pendingPrompt = this.pending.get(promptId)
    if (!pendingPrompt) return
    this.pending.delete(promptId)
    this.getWebContents()?.send(IPC.evtHostKeyExpired, promptId)
  }

  async connect(params: ConnectParams): Promise<SessionInfo> {
    const session = new SftpSession(params, (info) => this.verifyHostKey(info, session.id))
    session.on('close', () => {
      this.expireHostKeyPrompt(session.id)
      this.sessions.delete(session.id)
      for (const listener of this.closeListeners) listener(session.id)
      this.getWebContents()?.send(IPC.evtSessionClosed, session.id)
    })
    try {
      await session.connect()
    } catch (err) {
      this.expireHostKeyPrompt(session.id)
      await session.close()
      throw err
    }
    this.sessions.set(session.id, session)
    return {
      sessionId: session.id,
      host: params.host,
      port: params.port,
      username: params.username
    }
  }

  private async verifyHostKey(
    info: HostKeyInfo,
    sessionId: string
  ): Promise<{ accept: boolean; remember: boolean }> {
    const hostPort = `${info.host}:${info.port}`
    const known = await getKnownHost(hostPort)
    if (known && known.fingerprint === info.fingerprint) {
      return { accept: true, remember: false }
    }
    const enriched: HostKeyInfo = known
      ? { ...info, known: 'changed', previousFingerprint: known.fingerprint }
      : { ...info, known: 'unknown' }

    const promptId = randomUUID()
    this.promptIdBySession.set(sessionId, promptId)
    this.sessionByPromptId.set(promptId, sessionId)
    const response = new Promise<{ accept: boolean; remember: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(promptId)
        this.promptIdBySession.delete(sessionId)
        this.sessionByPromptId.delete(promptId)
        this.getWebContents()?.send(IPC.evtHostKeyExpired, promptId)
        resolve({ accept: false, remember: false })
      }, 60000)
      this.pending.set(promptId, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        }
      })
    })
    this.getWebContents()?.send(IPC.evtHostKeyPrompt, { promptId, info: enriched })
    const answer = await response
    if (this.sessionByPromptId.get(promptId) === sessionId) {
      this.promptIdBySession.delete(sessionId)
      this.sessionByPromptId.delete(promptId)
    }
    if (answer.accept && answer.remember) {
      await trustKnownHost(hostPort, info.fingerprint)
    }
    return answer
  }

  respondHostKey(promptId: string, accept: boolean, remember: boolean): void {
    const pendingPrompt = this.pending.get(promptId)
    if (!pendingPrompt) return
    this.pending.delete(promptId)
    const sessionId = this.sessionByPromptId.get(promptId)
    if (sessionId) {
      this.sessionByPromptId.delete(promptId)
      if (this.promptIdBySession.get(sessionId) === promptId) {
        this.promptIdBySession.delete(sessionId)
      }
    }
    pendingPrompt.resolve({ accept, remember })
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    await session.close()
  }

  async disconnectAll(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => session.close()))
  }
}
