import { randomUUID } from 'node:crypto'
import type { AiSessionCallbacks, AiSessionPort, InterviewRepository, SecretStore } from '../../domain/ports'
import type { AiReadiness, Interview, PendingCommand, Question, Settings } from '../../domain/types'
import { CodexManagerClient } from './codex-manager'

/** Disposable metadata for a cloud handshake; never writes a local interview. */
class ProbeRepository implements InterviewRepository {
  private interview?: Interview
  saveInterview(value: Interview): void { this.interview = structuredClone(value) }
  getInterview(): Interview | undefined { return this.interview }
  listInterviews(): [] { return [] }
  saveQuestion(): void {}
  listQuestions(): Question[] { return [] }
  deleteInterview(): void {}
  savePending(_value: PendingCommand): void {}
  listPending(): PendingCommand[] { return [] }
  deletePending(): void {}
  transaction<T>(action: () => T): T { return action() }
}

export class CloudAiClient implements AiSessionPort {
  private client: CodexManagerClient
  constructor(repository: InterviewRepository, private readonly secrets: SecretStore) { this.client = new CodexManagerClient(repository) }
  private token(): string { const value = this.secrets.getToken(); if (!value) throw new Error('Добавьте клиентский токен codex-manager в настройках.'); return value }
  connect(interview: Interview, callbacks: AiSessionCallbacks): Promise<void> { return this.client.connect(interview, this.token(), callbacks) }
  send(question: Question, text: string, signal: AbortSignal) { return this.client.send(question, text, signal) }
  cancel() { return this.client.cancel() }
  close() { return this.client.close() }
  disconnect(): void { this.client.disconnect() }
  async probe(settings: Settings): Promise<AiReadiness> {
    const repository = new ProbeRepository()
    const client = new CodexManagerClient(repository, { retryDelaysMs: [0] })
    const interview: Interview = { id: randomUUID(), title: 'Проверка подключения', createdAt: Date.now(), updatedAt: Date.now(), provider: 'cloud', localCodex: settings.localCodex,
      serviceUrl: settings.serviceUrl, profileSlug: settings.profileSlug, profile: { resume: '', vacancy: '', instructions: '', responseStyle: 'brief' }, completed: false, remote: { openRequestId: randomUUID(), lastSequence: 0, contextSent: false } }
    try {
      await client.connect(interview, this.token(), { onConnection: () => {}, onPartial: () => {}, onRemote: () => {} })
      await client.close()
      return { provider: 'cloud', status: 'ready', message: 'Клиентский токен и профиль приняты сервисом.' }
    } catch (error) { return { provider: 'cloud', status: 'error', message: error instanceof Error ? error.message : 'Сервис недоступен.' } }
    finally { client.disconnect() }
  }
}

export class AiProviderRouter implements AiSessionPort {
  private active?: AiSessionPort
  constructor(private readonly cloud: AiSessionPort, private readonly local: AiSessionPort) {}
  async connect(interview: Interview, callbacks: AiSessionCallbacks, options?: { allowRecreate?: boolean }): Promise<void> {
    const next = interview.provider === 'local' ? this.local : this.cloud
    if (this.active && this.active !== next) this.active.disconnect()
    this.active = next
    await next.connect(interview, callbacks, options)
  }
  probe(settings: Settings) { return (settings.provider === 'local' ? this.local : this.cloud).probe(settings) }
  send(question: Question, text: string, signal: AbortSignal) { if (!this.active) return Promise.reject(new Error('AI не подключён.')); return this.active.send(question, text, signal) }
  async cancel(): Promise<void> { await this.active?.cancel() }
  async close(): Promise<void> { await this.active?.close(); this.active = undefined }
  disconnect(): void { this.active?.disconnect(); this.active = undefined }
  async dispose(): Promise<void> { this.disconnect(); await Promise.all([this.cloud.dispose?.(), this.local.dispose?.()]) }
}
