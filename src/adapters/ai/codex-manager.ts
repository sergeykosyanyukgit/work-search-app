import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { AiAnswer, AiSessionCallbacks, AiSessionPort, InterviewRepository } from '../../domain/ports'
import type { Interview, PendingCommand, Question, RemoteSession } from '../../domain/types'

type Command = { v: 1; type: string; clientRequestId: string; payload: Record<string, unknown> }
type Event = { v: 1; type: string; sequence: number; sessionId?: string; turnId?: string; clientRequestId?: string; payload: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
type ActiveTurn = {
  questionId: string; command: Command; result: Deferred<AiAnswer>; turnId?: string
  timer: ReturnType<typeof setTimeout>; signal: AbortSignal; abort: () => void
  cancelling: boolean; cancelCommand?: Command; busyRetries: number
  deliveredSocket?: WebSocket
}

export interface CodexManagerOptions {
  handshakeTimeoutMs?: number
  responseTimeoutMs?: number
  retryDelaysMs?: number[]
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function command(value: unknown): value is Command {
  return object(value) && value.v === 1 && typeof value.type === 'string' && typeof value.clientRequestId === 'string' && object(value.payload)
}
function event(value: unknown): value is Event {
  return object(value) && value.v === 1 && typeof value.type === 'string' && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 && object(value.payload)
}
function aborted(): Error { return Object.assign(new Error('Запрос отменён'), { name: 'AbortError' }) }
function errorText(value: unknown): string { return value instanceof Error ? value.message : 'Ошибка подключения к AI' }

class ServiceError extends Error {
  constructor(message: string, readonly retryable = false) { super(message) }
}

/** Owns the authenticated transport and durable outbox. Never expose this object to a renderer. */
export class CodexManagerClient {
  private socket?: WebSocket
  private interview?: Interview
  private token = ''
  private callbacks?: AiSessionCallbacks
  private wanted = false
  private ready = false
  private epoch = 0
  private connecting?: Promise<void>
  private events: Promise<void> = Promise.resolve()
  private readyGate?: { nonce: string; result: Deferred<void> }
  private closeGate?: Deferred<void>
  private active?: ActiveTurn
  private outcomes = new Map<string, AiAnswer | Error>()
  private answerItems = new Map<string, Map<string, string>>()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private readonly timeout: number
  private readonly responseTimeout: number
  private readonly retryDelays: number[]

  constructor(private readonly repository: InterviewRepository, options: CodexManagerOptions = {}) {
    this.timeout = options.handshakeTimeoutMs ?? 8_000
    this.responseTimeout = options.responseTimeoutMs ?? 180_000
    this.retryDelays = options.retryDelaysMs ?? [0, 300, 1_000, 2_000, 5_000]
  }

  async connect(interview: Interview, token: string, callbacks: AiSessionCallbacks): Promise<void> {
    if (this.wanted && this.interview?.id === interview.id && this.token === token.trim()) {
      this.callbacks = callbacks
      await this.ensureConnected()
      return
    }
    this.disconnect()
    this.outcomes.clear()
    this.answerItems.clear()
    this.validateUrl(interview.serviceUrl)
    if (!token.trim() || /[\r\n]/.test(token)) throw new ServiceError('Укажите корректный токен клиента')
    this.interview = structuredClone(interview)
    this.token = token.trim()
    this.callbacks = callbacks
    this.wanted = true
    callbacks.onConnection('connecting')
    await this.ensureConnected()
  }

  async send(question: Question, text: string, signal: AbortSignal): Promise<AiAnswer> {
    if (!this.interview || !this.wanted) throw new ServiceError('Сначала подключитесь к AI')
    if (this.active) throw new ServiceError('Предыдущий запрос ещё выполняется')
    if (question.interviewId !== this.interview.id) throw new ServiceError('Вопрос принадлежит другому собеседованию')
    if (signal.aborted) throw aborted()
    const recovered = this.outcomes.get(question.id)
    if (recovered instanceof Error) throw recovered
    if (recovered) return recovered
    const stored = this.repository.listQuestions(question.interviewId).find(row => row.id === question.id)
    if (stored?.status === 'completed' && stored.turnId) return { text: stored.answer, turnId: stored.turnId }
    if (this.pendingStarts().some(row => row.questionId !== question.id)) throw new ServiceError('Сначала восстановите результат предыдущего отправленного запроса')
    const pending = this.pendingStart(question.id)
    const request = pending && command(pending.command) ? pending.command : this.makeCommand('turn.start', {
      inputs: [{ type: 'text', text }], originator: 'chatgpt'
    })
    if (!pending && !text.trim()) throw new ServiceError('Вопрос не должен быть пустым')
    const result = deferred<AiAnswer>()
    // Register the rejection consumer before asynchronous delivery or an already queued abort.
    void result.promise.catch(() => undefined)
    const active: ActiveTurn = {
      questionId: question.id, command: request, result, turnId: stored?.turnId ?? question.turnId,
      cancelling: false, busyRetries: 0, signal, abort: () => { void this.cancel().catch(error => this.failActive(error)) },
      timer: setTimeout(() => {
        void this.cancel().catch(() => undefined)
        this.failActive(new ServiceError('Истекло время ожидания ответа. Состояние запроса сохранено для восстановления.'))
      }, this.responseTimeout)
    }
    this.active = active
    const previousCancel = this.pendingFor(question.id).find(row => command(row.command) && row.command.type === 'turn.cancel')
    if (previousCancel && command(previousCancel.command)) { active.cancelling = true; active.cancelCommand = previousCancel.command }
    this.persist(request, question.id)
    signal.addEventListener('abort', active.abort, { once: true })
    try {
      await this.ensureConnected()
      if (this.active === active) await this.deliverActive()
    } catch (error) { this.failActive(error) }
    return result.promise
  }

  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    active.cancelling = true
    await this.ensureConnected()
    if (this.active === active) await this.deliverActive()
    // A cancel acknowledgement is a terminal event, not successful socket.send().
    await Promise.race([
      active.result.promise.then(() => undefined, error => {
        if (error instanceof Error && error.name === 'AbortError') return
        throw error
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new ServiceError('Отмена ещё не подтверждена сервисом')), 15_000)
        void active.result.promise.finally(() => clearTimeout(timer)).catch(() => undefined)
      })
    ])
  }

  async close(): Promise<void> {
    if (!this.interview || !this.wanted) return
    // Best effort only on an idle, ready socket. Unknown delivery is reconciled
    // on resume; closing must never reconnect or turn it into a cancellation.
    if (!this.ready || this.active || this.pendingStarts().length) { this.disconnect(); return }
    const epoch = this.epoch
    const result = deferred<void>()
    this.closeGate = result
    const timer = setTimeout(() => result.reject(new ServiceError('Сервис не подтвердил закрытие сессии')), Math.min(this.timeout, 1_000))
    try {
      this.write(this.makeCommand('session.close', { cancelActive: true }))
      await result.promise
    } finally {
      clearTimeout(timer)
      if (this.closeGate === result) this.closeGate = undefined
      if (epoch === this.epoch) this.disconnect()
    }
  }

  disconnect(): void {
    this.wanted = false
    this.ready = false
    this.epoch++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.readyGate?.result.reject(new ServiceError('Подключение закрыто'))
    this.readyGate = undefined
    this.closeGate?.reject(new ServiceError('Подключение закрыто'))
    this.closeGate = undefined
    this.socket?.removeAllListeners()
    this.socket?.on('error', () => undefined)
    this.socket?.terminate()
    this.socket = undefined
    this.connecting = undefined
    this.events = Promise.resolve()
    this.failActive(new ServiceError('Подключение закрыто; незавершённый запрос сохранён'))
    this.token = ''
    this.callbacks?.onConnection('disconnected')
  }

  private ensureConnected(): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const promise = this.connectLoop(epoch).finally(() => { if (this.connecting === promise) this.connecting = undefined })
    this.connecting = promise
    return promise
  }

  private async connectLoop(epoch: number): Promise<void> {
    let last: unknown = new ServiceError('Сервис недоступен', true)
    for (const delay of this.retryDelays) {
      if (!this.wanted || epoch !== this.epoch) throw new ServiceError('Подключение закрыто')
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (!this.wanted || epoch !== this.epoch) throw new ServiceError('Подключение закрыто')
      try {
        if (this.interview!.remote.sessionId) await this.recoverSession(epoch)
        if (epoch !== this.epoch) throw new ServiceError('Подключение закрыто')
        await this.openSocket(epoch)
        this.ready = true
        this.callbacks?.onConnection('ready')
        if (this.active) await this.deliverActive()
        return
      } catch (error) {
        if (epoch !== this.epoch) throw new ServiceError('Подключение закрыто')
        last = error
        this.ready = false
        this.socket?.removeAllListeners()
        this.socket?.on('error', () => undefined)
        this.socket?.terminate()
        this.socket = undefined
        if (error instanceof ServiceError && !error.retryable) break
        if (epoch === this.epoch) this.callbacks?.onConnection('recovering', this.redact(errorText(error)))
      }
    }
    const failure = new ServiceError(this.redact(errorText(last)))
    if (epoch === this.epoch) { this.callbacks?.onConnection('error', failure.message); this.failActive(failure) }
    throw failure
  }

  private async recoverSession(epoch: number): Promise<void> {
    const id = this.interview!.remote.sessionId!
    const snapshot = await this.rest(`/api/v1/sessions/${encodeURIComponent(id)}`, true)
    if (epoch !== this.epoch) return
    if (!object(snapshot) || snapshot.status === 'CLOSED' || snapshot.status === 'EXPIRED') {
      // Never replay an uncertain turn into a new session: its idempotency key is session-scoped.
      if (this.pendingStarts().length) {
        const error = new ServiceError('Удалённая сессия завершена или удалена. Незавершённый вопрос требует явного повтора.')
        this.repository.transaction(() => {
          for (const pending of this.pendingStarts()) {
            const question = this.repository.listQuestions(this.interview!.id).find(row => row.id === pending.questionId)
            if (question) this.repository.saveQuestion({ ...question, status: 'interrupted', error: error.message })
            if (pending.questionId) {
              for (const entry of this.pendingFor(pending.questionId)) this.repository.deletePending(entry.id)
              this.answerItems.delete(pending.questionId)
            } else this.repository.deletePending(pending.id)
          }
        })
        this.failActive(error)
      }
      this.updateRemote({ openRequestId: randomUUID(), lastSequence: 0, contextSent: false })
      return
    }
    await this.recoverHistory(epoch)
    // REST turn records are authoritative if stream history is no longer available.
    for (const pending of this.pendingStarts()) {
      if (!command(pending.command)) continue
      const requestId = pending.command.clientRequestId
      const rows = await this.rest(`/api/v1/sessions/${encodeURIComponent(id)}/turns?limit=100`)
      if (epoch !== this.epoch) return
      if (!Array.isArray(rows)) throw new ServiceError('Некорректная история запросов сервиса')
      const row = rows.find(candidate => object(candidate) && candidate.clientRequestId === requestId)
      if (object(row)) this.applyTurnSnapshot(row, pending)
    }
    if (typeof snapshot.lastSequence === 'number' && snapshot.lastSequence > this.interview!.remote.lastSequence) {
      // No events returned after retention, but terminal turn snapshots above were reconciled first.
      this.updateRemote({ ...this.interview!.remote, lastSequence: snapshot.lastSequence })
    }
  }

  private async recoverHistory(epoch: number): Promise<void> {
    const id = this.interview!.remote.sessionId
    if (!id) return
    for (let page = 0; page < 100; page++) {
      const cursor = this.interview!.remote.lastSequence
      const rows = await this.rest(`/api/v1/sessions/${encodeURIComponent(id)}/events?afterSequence=${cursor}&limit=1000`)
      if (epoch !== this.epoch) return
      if (!Array.isArray(rows)) throw new ServiceError('Некорректная история событий сервиса')
      const parsed = rows.filter(event).sort((left, right) => left.sequence - right.sequence)
      if (parsed.length !== rows.length) throw new ServiceError('Некорректное событие в истории сервиса')
      for (const entry of parsed) this.applyEvent(entry)
      if (rows.length < 1000 || this.interview!.remote.lastSequence === cursor) return
    }
    throw new ServiceError('Слишком большая история событий для восстановления')
  }

  private openSocket(epoch: number): Promise<void> {
    const result = deferred<void>()
    const nonce = randomUUID()
    this.readyGate = { nonce, result }
    const url = new URL('/api/v1/ws', this.interview!.serviceUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, 'codex-manager.v1', {
      headers: { authorization: `Bearer ${this.token}` }, handshakeTimeout: this.timeout,
      maxPayload: 1_048_576, perMessageDeflate: false
    })
    this.socket = socket
    const timer = setTimeout(() => result.reject(new ServiceError('Сервис не подтвердил подключение', true)), this.timeout)
    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      result.reject(new ServiceError(response.statusCode === 401 ? 'Токен клиента недействителен или истёк' :
        response.statusCode === 403 ? 'Токен не даёт права sessions:write' :
          `Сервис отклонил WebSocket (${response.statusCode ?? 'HTTP'})`, (response.statusCode ?? 0) >= 500))
    })
    socket.on('error', () => result.reject(new ServiceError('Не удалось подключиться к WebSocket', true)))
    socket.on('open', () => {
      if (epoch !== this.epoch) return socket.terminate()
      const remote = this.interview!.remote
      this.write({ v: 1, type: 'session.open', clientRequestId: remote.openRequestId, payload: remote.sessionId
        ? { sessionId: remote.sessionId, afterSequence: remote.lastSequence }
        : { profile: { slug: this.interview!.profileSlug } } })
      // The service serializes commands. Pong confirms open, including a resume with no new ready event.
      this.write(this.makeCommand('ping', { nonce }))
    })
    socket.on('message', (data, binary) => {
      if (epoch !== this.epoch) return
      this.events = this.events.then(async () => {
        if (epoch !== this.epoch) return
        if (binary) throw new ServiceError('Сервис прислал неподдерживаемый бинарный ответ')
        let value: unknown
        try { value = JSON.parse(data.toString()) } catch { throw new ServiceError('Сервис прислал некорректный JSON') }
        if (!event(value)) throw new ServiceError('Сервис прислал некорректное событие')
        if (this.interview!.remote.sessionId && value.sessionId && value.sessionId !== this.interview!.remote.sessionId) throw new ServiceError('Сервис прислал событие другой сессии')
        if (value.sequence > this.interview!.remote.lastSequence + 1 && this.interview!.remote.sessionId) await this.recoverHistory(epoch)
        if (epoch === this.epoch) this.applyEvent(value)
      }).catch(error => { result.reject(error); this.failActive(error); socket.terminate() })
    })
    socket.on('close', () => {
      result.reject(new ServiceError('Соединение с сервисом потеряно', true))
      if (epoch !== this.epoch || !this.wanted || socket !== this.socket) return
      this.ready = false
      this.callbacks?.onConnection('recovering')
      // Let an in-flight connect attempt own its retry loop; established connections need a new loop.
      if (!this.connecting) this.reconnectTimer = setTimeout(() => { void this.ensureConnected().catch(() => undefined) }, 0)
    })
    return result.promise.finally(() => {
      clearTimeout(timer)
      if (this.readyGate?.result === result) this.readyGate = undefined
    })
  }

  private applyEvent(entry: Event): void {
    if (!this.interview) return
    // Readiness is not durable state: replay may have already advanced beyond this pong.
    if (entry.type === 'pong' && this.readyGate?.nonce === entry.payload.nonce) this.readyGate?.result.resolve()
    if (entry.sequence > 0 && entry.sequence <= this.interview.remote.lastSequence) return
    if (entry.type === 'protocol.error') {
      const failure = new ServiceError(this.redact(typeof entry.payload.message === 'string' ? entry.payload.message : 'Ошибка протокола AI'))
      const active = this.active
      if (active && !active.turnId && active.busyRetries < 20 && /Session is not ready for a new turn|Session already has an active turn/.test(failure.message)) {
        // Manager may publish terminal events before its database reconciler marks the session IDLE.
        active.busyRetries++
        setTimeout(() => { if (this.active === active) void this.deliverActive(true).catch(error => this.failActive(error)) }, 250)
      } else {
        this.readyGate?.result.reject(failure)
        this.closeGate?.reject(failure)
        if (active) {
          // Protocol errors have no request correlation in v1. An error from cancel (or a
          // failed acknowledgement) does not establish that the underlying turn is terminal.
          const rejectedBeforeAdmission = this.ready && !active.turnId && !active.cancelling &&
            /^(Queued turn quota exceeded|Daily turn quota exhausted|Daily token quota exhausted)$/.test(failure.message)
          if (rejectedBeforeAdmission) {
            this.finishQuestion(active.questionId, 'failed', undefined, failure.message)
            this.failActive(failure)
          } else {
            const message = `Сервис не подтвердил результат команды. Запрос сохранён для восстановления. ${failure.message}`
            const question = this.repository.listQuestions(this.interview.id).find(row => row.id === active.questionId)
            if (question) this.repository.saveQuestion({ ...question, status: 'interrupted', error: message })
            this.failActive(new ServiceError(message))
          }
        }
      }
    }
    if (entry.type === 'session.closed') this.closeGate?.resolve()
    if (entry.sequence <= this.interview.remote.lastSequence) return
    if (entry.sessionId && !this.interview.remote.sessionId) this.updateRemote({ ...this.interview.remote, sessionId: entry.sessionId })
    const pending = entry.clientRequestId ? this.pendingStarts().find(row => row.id === entry.clientRequestId) : undefined
    const question = this.repository.listQuestions(this.interview.id).find(row =>
      (pending?.questionId && row.id === pending.questionId) || (entry.turnId && row.turnId === entry.turnId))
    this.repository.transaction(() => {
      if (question && entry.turnId) {
        if (this.active?.questionId === question.id) this.active.turnId = entry.turnId
        if (entry.type === 'turn.queued' || entry.type === 'turn.started') {
          this.repository.saveQuestion({ ...question, turnId: entry.turnId, status: 'generating' })
          this.interview!.remote.contextSent = true
          this.callbacks?.onPartial(question.id, question.answer, entry.turnId)
        }
        if (entry.type === 'codex.event') {
          const item = entry.payload.item
          if (['item.started', 'item.updated', 'item.completed'].includes(String(entry.payload.type)) && object(item) && item.type === 'agent_message' && typeof item.id === 'string' && typeof item.text === 'string' && !this.outcomes.has(question.id)) {
            const answer = this.mergeAnswerItem(question.id, item.id, item.text)
            this.repository.saveQuestion({ ...question, turnId: entry.turnId, status: 'generating', answer })
            this.callbacks?.onPartial(question.id, answer, entry.turnId)
          }
        }
        if (entry.type === 'turn.completed') {
          if (typeof entry.payload.finalResponse !== 'string') throw new ServiceError('Сервис не вернул итоговый ответ')
          this.finishQuestion(question.id, 'completed', entry.payload.finalResponse, undefined, entry.turnId)
          this.completeActive(question.id, { text: entry.payload.finalResponse, turnId: entry.turnId })
        }
        if (entry.type === 'turn.failed' || entry.type === 'turn.cancelled') {
          const message = entry.type === 'turn.cancelled' ? 'Запрос отменён' : this.redact(String(entry.payload.message ?? entry.payload.code ?? 'Не удалось получить ответ'))
          this.finishQuestion(question.id, entry.type === 'turn.cancelled' ? 'cancelled' : 'failed', undefined, message, entry.turnId)
          if (this.active?.questionId === question.id) this.failActive(entry.type === 'turn.cancelled' ? aborted() : new ServiceError(message))
        }
      }
      this.updateRemote({ ...this.interview!.remote, lastSequence: entry.sequence })
    })
    if (this.active?.cancelling && this.active.turnId) this.sendCancel(this.active)
  }

  private applyTurnSnapshot(row: Record<string, unknown>, pending: PendingCommand): void {
    if (typeof row.id !== 'string' || !pending.questionId) return
    const question = this.repository.listQuestions(this.interview!.id).find(entry => entry.id === pending.questionId)
    if (!question) return
    this.repository.saveQuestion({ ...question, turnId: row.id })
    if (this.active?.questionId === question.id) this.active.turnId = row.id
    if (row.status === 'COMPLETED' && typeof row.finalResponse === 'string') {
      this.finishQuestion(question.id, 'completed', row.finalResponse, undefined, row.id)
      this.completeActive(question.id, { text: row.finalResponse, turnId: row.id })
    } else if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(String(row.status))) {
      const message = object(row.error) ? String(row.error.message ?? row.error.code ?? 'Ошибка AI') : String(row.errorCode ?? 'Запрос прерван')
      this.finishQuestion(question.id, row.status === 'CANCELLED' ? 'cancelled' : 'failed', undefined, this.redact(message), row.id)
      if (this.active?.questionId === question.id) this.failActive(row.status === 'CANCELLED' ? aborted() : new ServiceError(this.redact(message)))
    }
  }

  private async deliverActive(retry = false): Promise<void> {
    const active = this.active
    if (!active || !this.ready) return
    const stored = this.repository.listQuestions(this.interview!.id).find(row => row.id === active.questionId)
    if (stored?.status === 'completed' && stored.turnId) { this.completeActive(stored.id, { text: stored.answer, turnId: stored.turnId }); return }
    if (active.cancelling && active.turnId) { this.sendCancel(active); return }
    // Both send() and connection recovery can reach delivery after the handshake.
    // Retry only on a new socket or a known admission race, using the same durable ID.
    if (!retry && active.deliveredSocket === this.socket) return
    this.write(active.command)
    active.deliveredSocket = this.socket
  }

  private sendCancel(active: ActiveTurn): void {
    if (!active.turnId || this.socket?.readyState !== WebSocket.OPEN) return
    active.cancelCommand ??= this.makeCommand('turn.cancel', { turnId: active.turnId })
    this.persist(active.cancelCommand, active.questionId)
    this.write(active.cancelCommand)
  }

  private finishQuestion(id: string, status: Question['status'], answer?: string, error?: string, turnId?: string): void {
    const question = this.repository.listQuestions(this.interview!.id).find(row => row.id === id)
    if (question) this.repository.saveQuestion({ ...question, status, answer: answer ?? question.answer, error, turnId: turnId ?? question.turnId })
    if (status === 'completed' && answer !== undefined && turnId) this.outcomes.set(id, { text: answer, turnId })
    else if (status === 'cancelled') this.outcomes.set(id, aborted())
    else if (status === 'failed') this.outcomes.set(id, new ServiceError(error ?? 'Запрос не выполнен'))
    for (const pending of this.pendingFor(id)) this.repository.deletePending(pending.id)
    this.answerItems.delete(id)
  }

  private mergeAnswerItem(questionId: string, itemId: string, text: string): string {
    let items = this.answerItems.get(questionId)
    if (!items) {
      items = new Map<string, string>()
      const snapshot = this.pendingFor(questionId).find(row => object(row.command) && row.command.type === 'local.answer-items')?.command
      if (object(snapshot) && Array.isArray(snapshot.items)) {
        for (const row of snapshot.items) {
          if (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string') items.set(row[0], row[1])
        }
      }
      this.answerItems.set(questionId, items)
    }
    // Map.set replaces the snapshot for one item without changing its initial position.
    items.set(itemId, text)
    this.repository.savePending({
      provider: 'cloud', id: `answer-items:${questionId}`, interviewId: this.interview!.id, questionId,
      sessionId: this.interview!.remote.sessionId, createdAt: Date.now(),
      // This local metadata never passes through write(); only turn.start/cancel are delivered.
      command: { type: 'local.answer-items', items: [...items] }
    })
    return [...items.values()].filter(Boolean).join('\n\n')
  }

  private completeActive(id: string, answer: AiAnswer): void {
    if (this.active?.questionId !== id) return
    const active = this.active
    this.clearActive(active)
    active.result.resolve(answer)
  }
  private failActive(error: unknown): void {
    if (!this.active) return
    const active = this.active
    this.clearActive(active)
    const failure = error instanceof Error && error.name === 'AbortError' ? error : new ServiceError(this.redact(errorText(error)))
    active.result.reject(failure)
  }
  private clearActive(active: ActiveTurn): void {
    clearTimeout(active.timer)
    active.signal.removeEventListener('abort', active.abort)
    if (this.active === active) this.active = undefined
  }
  private updateRemote(remote: RemoteSession): void {
    if (!this.interview) return
    this.interview.remote = { ...remote }
    const latest = this.repository.getInterview(this.interview.id) ?? this.interview
    this.repository.saveInterview({ ...latest, remote: { ...remote }, updatedAt: Date.now() })
    this.callbacks?.onRemote({ ...remote })
  }
  private pendingFor(questionId: string): PendingCommand[] { return this.repository.listPending(this.interview!.id).filter(row => row.questionId === questionId) }
  private pendingStarts(): PendingCommand[] { return this.repository.listPending(this.interview!.id).filter(row => command(row.command) && row.command.type === 'turn.start') }
  private pendingStart(questionId: string): PendingCommand | undefined { return this.pendingStarts().find(row => row.questionId === questionId) }
  private makeCommand(type: string, payload: Record<string, unknown>): Command { return { v: 1, type, clientRequestId: randomUUID(), payload } }
  private persist(value: Command, questionId?: string): void {
    this.repository.savePending({ provider: 'cloud', id: value.clientRequestId, interviewId: this.interview!.id, questionId, sessionId: this.interview!.remote.sessionId, command: value, createdAt: Date.now() })
  }
  private write(value: Command): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new ServiceError('Соединение с AI недоступно', true)
    this.socket.send(JSON.stringify(value))
  }
  private async rest(path: string, allowNotFound = false): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(new URL(path, this.interview!.serviceUrl), { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(this.timeout), redirect: 'error' })
    } catch { throw new ServiceError('Не удалось восстановить состояние AI', true) }
    if (allowNotFound && response.status === 404) return undefined
    if (!response.ok) throw new ServiceError(response.status === 401 ? 'Токен клиента недействителен или истёк' : response.status === 403 ? 'Для восстановления нужен доступ sessions:read' : `Ошибка сервиса (${response.status})`, response.status >= 500 || response.status === 429)
    try { return await response.json() } catch { throw new ServiceError('Сервис вернул некорректный JSON') }
  }
  private redact(message: string): string { return message.replaceAll(this.token || '\0', '[token]').replace(/cm_live_[A-Za-z0-9_-]+/g, '[token]').slice(0, 500) }
  private validateUrl(raw: string): void {
    let url: URL
    try { url = new URL(raw) } catch { throw new ServiceError('Некорректный адрес сервиса') }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new ServiceError('Используйте HTTPS; HTTP допустим только для localhost')
  }
}
