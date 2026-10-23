import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexManagerClient } from '../src/adapters/ai/codex-manager'
import type { InterviewRepository } from '../src/domain/ports'
import type { Interview, PendingCommand, Question } from '../src/domain/types'

class MemoryRepository implements InterviewRepository {
  interviews = new Map<string, Interview>()
  questions = new Map<string, Question>()
  pending = new Map<string, PendingCommand>()
  saveInterview(row: Interview): void { this.interviews.set(row.id, structuredClone(row)) }
  getInterview(id: string): Interview | undefined { return structuredClone(this.interviews.get(id)) }
  listInterviews() { return [...this.interviews.values()].map(row => ({ ...row, questionCount: this.listQuestions(row.id).length })) }
  saveQuestion(row: Question): void { this.questions.set(row.id, structuredClone(row)) }
  listQuestions(id: string): Question[] { return structuredClone([...this.questions.values()].filter(row => row.interviewId === id)) }
  deleteInterview(id: string): void { this.interviews.delete(id) }
  savePending(row: PendingCommand): void { this.pending.set(row.id, structuredClone(row)) }
  listPending(id: string): PendingCommand[] { return structuredClone([...this.pending.values()].filter(row => row.interviewId === id)) }
  deletePending(id: string): void { this.pending.delete(id) }
  transaction<T>(action: () => T): T { return action() }
}

type Wire = { v: number; type: string; clientRequestId: string; payload: Record<string, unknown> }
type WireEvent = { v: number; type: string; sequence: number; sessionId: string; turnId?: string; clientRequestId?: string; payload: Record<string, unknown> }
class FakeService {
  http: Server
  ws = new WebSocketServer({ noServer: true })
  url = ''
  sessionId = randomUUID()
  status = 'IDLE'
  events: WireEvent[] = []
  rows = new Map<string, Record<string, unknown>>()
  received: Wire[] = []
  connections = 0
  rejectAuth = false
  historyReads = 0
  busyResponses = 0
  startRejection?: string
  cancelRejection?: string
  ignoreClose = false
  onTurn: (entry: Wire, socket: WebSocket, turnId: string) => void = () => undefined
  constructor() {
    this.http = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer fixture-token') { response.writeHead(401).end(); return }
      const url = new URL(request.url!, 'http://localhost')
      response.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('/events')) {
        this.historyReads++
        const cursor = Number(url.searchParams.get('afterSequence'))
        // PostgreSQL history does not preserve clientRequestId in the actual service.
        response.end(JSON.stringify(this.events.filter(entry => entry.sequence > cursor).map(({ clientRequestId: _id, ...entry }) => entry)))
      } else if (url.pathname.endsWith('/turns')) response.end(JSON.stringify([...this.rows.values()].reverse()))
      else response.end(JSON.stringify({ id: this.sessionId, status: this.status, lastSequence: this.events.length }))
    })
    this.http.on('upgrade', (request, socket, head) => {
      this.connections++
      if (this.rejectAuth || request.headers.authorization !== 'Bearer fixture-token') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
      if (request.headers['sec-websocket-protocol'] !== 'codex-manager.v1') { socket.destroy(); return }
      this.ws.handleUpgrade(request, socket, head, client => this.ws.emit('connection', client))
    })
    this.ws.on('connection', socket => socket.on('message', data => {
      const entry = JSON.parse(data.toString()) as Wire
      this.received.push(entry)
      if (entry.type === 'session.open') {
        if (!entry.payload.sessionId && !this.events.length) this.emit('session.accepted', { status: 'IDLE' }, undefined, entry.clientRequestId)
        else for (const item of this.events.filter(item => item.sequence > Number(entry.payload.afterSequence ?? 0))) socket.send(JSON.stringify(item))
      } else if (entry.type === 'ping') this.emit('pong', entry.payload)
      else if (entry.type === 'turn.start') {
        if (this.rows.has(entry.clientRequestId)) return
        if (this.busyResponses > 0) { this.busyResponses--; this.emit('protocol.error', { code: 'INVALID_COMMAND', message: 'Session is not ready for a new turn' }); return }
        if (this.startRejection) { this.emit('protocol.error', { code: 'INVALID_COMMAND', message: this.startRejection }); return }
        const id = randomUUID()
        this.rows.set(entry.clientRequestId, { id, clientRequestId: entry.clientRequestId, status: 'RUNNING' })
        this.status = 'RUNNING'
        this.emit('turn.queued', {}, id, entry.clientRequestId)
        this.onTurn(entry, socket, id)
      } else if (entry.type === 'turn.cancel') {
        if (this.cancelRejection) { this.emit('protocol.error', { code: 'INVALID_COMMAND', message: this.cancelRejection }); return }
        const row = [...this.rows.values()].find(row => row.id === entry.payload.turnId)
        if (row) row.status = 'CANCELLED'
        this.status = 'IDLE'
        this.emit('turn.cancelled', { reason: 'client_request' }, String(entry.payload.turnId))
      } else if (entry.type === 'session.close' && !this.ignoreClose) { this.status = 'CLOSED'; this.emit('session.closed', { status: 'CLOSED' }) }
    }))
  }
  async start() { await new Promise<void>(resolve => this.http.listen(0, '127.0.0.1', resolve)); this.url = `http://127.0.0.1:${(this.http.address() as { port: number }).port}`; return this }
  emit(type: string, payload: Record<string, unknown>, turnId?: string, clientRequestId?: string, broadcast = true) {
    const entry = { v: 1, type, payload, sequence: this.events.length + 1, sessionId: this.sessionId, turnId, clientRequestId }
    this.events.push(entry)
    if (broadcast) for (const socket of this.ws.clients) if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(entry))
  }
  complete(requestId: string, answer: string, broadcast = true) {
    const row = this.rows.get(requestId)!
    row.status = 'COMPLETED'; row.finalResponse = answer; this.status = 'IDLE'
    this.emit('turn.completed', { finalResponse: answer }, String(row.id), undefined, broadcast)
  }
  async stop() { for (const socket of this.ws.clients) socket.terminate(); await new Promise<void>(resolve => this.ws.close(() => resolve())); await new Promise<void>(resolve => this.http.close(() => resolve())) }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0 })

async function setup() {
  const service = await new FakeService().start()
  cleanups.push(() => service.stop())
  const repository = new MemoryRepository()
  const interview: Interview = { provider: 'cloud', localCodex: { executablePath: '', model: 'gpt-5.6-sol' }, id: randomUUID(), title: 'Тест', createdAt: 0, updatedAt: 0, completed: false, serviceUrl: service.url, profileSlug: 'interview-assistant', profile: { resume: '', vacancy: '', instructions: '', responseStyle: 'brief' }, remote: { openRequestId: randomUUID(), lastSequence: 0, contextSent: false } }
  const question: Question = { id: randomUUID(), interviewId: interview.id, createdAt: 0, order: 0, status: 'queued', text: 'Что такое замыкание?', answer: '', segments: [], partial: false }
  repository.saveInterview(interview); repository.saveQuestion(question)
  const client = new CodexManagerClient(repository, { handshakeTimeoutMs: 500, responseTimeoutMs: 5_000, retryDelaysMs: [0, 10, 20] })
  cleanups.push(() => client.disconnect())
  const callbacks = { onConnection: vi.fn(), onRemote: vi.fn(), onPartial: vi.fn() }
  return { service, repository, interview, question, client, callbacks }
}

describe('Codex Manager authenticated durable transport', () => {
  it('bounds an unacknowledged idle close and disconnects the socket', async () => {
    const { service, interview, client, callbacks } = await setup()
    service.ignoreClose = true
    await client.connect(interview, 'fixture-token', callbacks)
    await expect(client.close()).rejects.toThrow('не подтвердил закрытие')
    expect(callbacks.onConnection).toHaveBeenLastCalledWith('disconnected')
    expect(service.connections).toBe(1)
    expect(service.received.filter(row => row.type === 'session.close')).toHaveLength(1)
  })

  it('does not let an old close disconnect a replacement connection', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.ignoreClose = true
    await client.connect(interview, 'fixture-token', callbacks)
    const closing = client.close()
    const rejected = expect(closing).rejects.toThrow('Подключение закрыто')
    const reconnecting = client.connect({ ...interview, id: 'replacement', remote: { openRequestId: 'replacement-open', lastSequence: 0, contextSent: false } }, 'fixture-token', callbacks)
    await rejected
    await reconnecting
    service.onTurn = row => service.complete(row.clientRequestId, 'Replacement answer')
    const next = { ...question, id: 'replacement-question', interviewId: 'replacement' }
    repository.saveQuestion(next)
    await expect(client.send(next, 'Next question', new AbortController().signal)).resolves.toMatchObject({ text: 'Replacement answer' })
  })

  it('disconnects active delivery without reconnecting or cancelling and preserves the outbox', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    await client.connect(interview, 'fixture-token', callbacks)
    const answer = client.send(question, 'Question', new AbortController().signal)
    const rejected = expect(answer).rejects.toThrow('сохранён')
    await vi.waitFor(() => expect(service.received.some(row => row.type === 'turn.start')).toBe(true))
    await client.close()
    await rejected
    expect(repository.listPending(interview.id)).toHaveLength(1)
    expect(service.received.some(row => ['turn.cancel', 'session.close'].includes(row.type))).toBe(false)
    expect(service.connections).toBe(1)
  })

  it('shows app-server replacement events before completion and waits for the public terminal envelope', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.onTurn = (_request, _socket, id) => {
      // Shapes emitted by codex-manager's AppServerThread + RuntimeService.
      service.emit('turn.started', { threadId: 'thread' }, id)
      service.emit('codex.event', { type: 'turn.started' }, id)
      service.emit('codex.event', { type: 'item.started', item: { id: 'answer', type: 'agent_message', text: '' } }, id)
      service.emit('codex.event', { type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Прямой' } }, id)
      service.emit('codex.event', { type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Прямой ответ' } }, id)
    }
    await client.connect(interview, 'fixture-token', callbacks)
    let settled = false
    const answer = client.send(question, 'question', new AbortController().signal)
    void answer.then(() => { settled = true })
    await vi.waitFor(() => expect(callbacks.onPartial).toHaveBeenLastCalledWith(question.id, 'Прямой ответ', expect.any(String)))
    expect(settled).toBe(false)
    expect(repository.listQuestions(interview.id)[0]?.answer).toBe('Прямой ответ')
    const [requestId, row] = [...service.rows][0]!
    const turnId = String(row.id)
    service.emit('codex.event', { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Завершенный блок' } }, turnId)
    service.emit('codex.event', { type: 'turn.completed', usage: { input_tokens: 2000, output_tokens: 100, cached_input_tokens: 1500 } }, turnId)
    await vi.waitFor(() => expect(callbacks.onPartial).toHaveBeenLastCalledWith(question.id, 'Завершенный блок', turnId))
    expect(settled).toBe(false)
    row.status = 'COMPLETED'; row.finalResponse = 'Окончательный ответ'; service.status = 'IDLE'
    service.emit('turn.completed', { finalResponse: row.finalResponse, threadId: 'thread', usage: {
      inputTokens: 1000, outputTokens: 50, accounting: { version: 1, scope: 'turn' },
      latency: { firstAnswerMs: 1400, totalMs: 2600 }
    } }, turnId, requestId)
    expect(await answer).toEqual({ text: 'Окончательный ответ', turnId })
    expect(repository.listQuestions(interview.id)[0]?.answer).toBe('Окончательный ответ')
    expect(repository.listPending(interview.id)).toHaveLength(0)
    expect(repository.getInterview(interview.id)?.remote.lastSequence).toBe(service.events.length)
    expect(service.historyReads).toBe(0)
  })

  it('delivers once when a question arrives during the initial connection handshake', async () => {
    const { service, interview, question, client, callbacks } = await setup()
    service.onTurn = request => service.complete(request.clientRequestId, 'Answer')
    const connecting = client.connect(interview, 'fixture-token', callbacks)
    const answer = client.send(question, 'question', new AbortController().signal)
    await connecting
    expect((await answer).text).toBe('Answer')
    expect(service.received.filter(entry => entry.type === 'turn.start')).toHaveLength(1)
    expect(service.historyReads).toBe(0)
  })

  it('renders item snapshots without duplicating text and resolves the authoritative final answer', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.onTurn = (request, _socket, id) => {
      service.emit('codex.event', { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Замо' } }, id)
      service.emit('codex.event', { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Замыкание' } }, id)
      service.emit('codex.event', { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'private reasoning' } }, id)
      service.complete(request.clientRequestId, 'Итоговый ответ')
    }
    await client.connect(interview, 'fixture-token', callbacks)
    const answer = await client.send(question, 'Вопрос и контекст', new AbortController().signal)
    expect(answer.text).toBe('Итоговый ответ')
    expect(callbacks.onPartial.mock.calls.map(row => row[1])).toEqual(['', 'Замо', 'Замыкание'])
    expect(repository.listPending(interview.id)).toHaveLength(0)
    expect(repository.getInterview(interview.id)!.remote.contextSent).toBe(true)
    expect(service.received.find(row => row.type === 'turn.start')!.payload.originator).toBe('chatgpt')
  })

  it('recovers a dropped terminal event via REST without starting the turn again', async () => {
    const { service, interview, question, client, callbacks } = await setup()
    service.onTurn = (request, socket) => {
      service.complete(request.clientRequestId, 'Ответ восстановлен', false)
      socket.terminate()
    }
    await client.connect(interview, 'fixture-token', callbacks)
    expect((await client.send(question, 'first', new AbortController().signal)).text).toBe('Ответ восстановлен')
    expect(service.rows.size).toBe(1)
    expect(service.historyReads).toBeGreaterThan(0)
  })

  it('fills a sequence gap through REST and treats repeated agent snapshots as replacements', async () => {
    const { service, interview, question, client, callbacks } = await setup()
    service.onTurn = (request, _socket, id) => {
      service.emit('turn.started', {}, id, undefined, false)
      service.emit('codex.event', { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'Один текст' } }, id)
      service.complete(request.clientRequestId, 'Готово')
    }
    await client.connect(interview, 'fixture-token', callbacks)
    expect((await client.send(question, 'question', new AbortController().signal)).text).toBe('Готово')
    expect(service.historyReads).toBeGreaterThan(0)
    expect(callbacks.onPartial.mock.calls.filter(row => row[1] === 'Один текст')).toHaveLength(1)
  })

  it('reuses persisted request identity and exact payload after app restart', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    const id = randomUUID()
    const pending = { v: 1, type: 'turn.start', clientRequestId: id, payload: { originator: 'chatgpt', inputs: [{ type: 'text', text: 'Original exact prompt' }] } }
    repository.savePending({ id, interviewId: interview.id, questionId: question.id, command: pending, createdAt: 0 })
    service.onTurn = request => service.complete(request.clientRequestId, 'Тот же запрос')
    await client.connect(interview, 'fixture-token', callbacks)
    expect((await client.send(question, 'newly composed text must not overwrite outbox', new AbortController().signal)).text).toBe('Тот же запрос')
    expect(service.received.find(row => row.type === 'turn.start')).toEqual(pending)
    expect(service.rows.size).toBe(1)
  })

  it('resumes without a new session.ready acknowledgement', async () => {
    const { service, repository, interview, client, callbacks } = await setup()
    service.emit('session.accepted', { status: 'IDLE' }, undefined, undefined, false)
    interview.remote = { ...interview.remote, sessionId: service.sessionId, lastSequence: 1, contextSent: true }
    repository.saveInterview(interview)
    await client.connect(interview, 'fixture-token', callbacks)
    expect(callbacks.onConnection).toHaveBeenLastCalledWith('ready')
    expect(service.received[0]!.payload).toEqual({ sessionId: service.sessionId, afterSequence: 1 })
  })

  it('stops retrying invalid credentials and never prints the supplied credential in an error', async () => {
    const { service, interview, client, callbacks } = await setup()
    service.rejectAuth = true
    await expect(client.connect(interview, 'fixture-token', callbacks)).rejects.toThrow('Токен клиента')
    expect(service.connections).toBe(1)
    expect(JSON.stringify(callbacks.onConnection.mock.calls)).not.toContain('fixture-token')
  })

  it('persists cancellation and waits for the terminal cancelled event', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    await client.connect(interview, 'fixture-token', callbacks)
    const controller = new AbortController()
    const answer = client.send(question, 'question', controller.signal)
    const assertion = expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(service.rows.size).toBe(1))
    controller.abort()
    await assertion
    expect(repository.listQuestions(interview.id)[0]!.status).toBe('cancelled')
    expect(repository.listPending(interview.id)).toHaveLength(0)
  })

  it('opens a fresh remote session after expiry and resets context transfer', async () => {
    const { service, repository, interview, client, callbacks } = await setup()
    interview.remote = { ...interview.remote, sessionId: service.sessionId, contextSent: true }
    repository.saveInterview(interview)
    service.status = 'EXPIRED'
    await client.connect(interview, 'fixture-token', callbacks)
    expect(repository.getInterview(interview.id)!.remote.contextSent).toBe(false)
    expect(service.received[0]!.payload).toEqual({ profile: { slug: 'interview-assistant' } })
  })

  it('retries the same request while the manager reconciles a previous terminal turn', async () => {
    const { service, interview, question, client, callbacks } = await setup()
    service.busyResponses = 1
    service.onTurn = request => service.complete(request.clientRequestId, 'После reconcile')
    await client.connect(interview, 'fixture-token', callbacks)
    expect((await client.send(question, 'question', new AbortController().signal)).text).toBe('После reconcile')
    const requests = service.received.filter(row => row.type === 'turn.start')
    expect(requests.length).toBeGreaterThan(1)
    expect(new Set(requests.map(row => row.clientRequestId)).size).toBe(1)
    expect(service.rows.size).toBe(1)
  })

  it('shares an in-flight connection attempt for the same interview and credential', async () => {
    const { service, interview, client, callbacks } = await setup()
    await Promise.all([client.connect(interview, 'fixture-token', callbacks), client.connect(interview, 'fixture-token', callbacks)])
    expect(service.connections).toBe(1)
    expect(callbacks.onConnection).toHaveBeenLastCalledWith('ready')
  })

  it('restores authoritative REST turn state even when its event has expired', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.emit('session.accepted', {}, undefined, undefined, false)
    const id = randomUUID()
    const turnId = randomUUID()
    service.rows.set(id, { id: turnId, clientRequestId: id, status: 'COMPLETED', finalResponse: 'Stored server final' })
    interview.remote = { ...interview.remote, sessionId: service.sessionId, lastSequence: 1 }
    repository.saveInterview(interview)
    repository.savePending({ id, interviewId: interview.id, questionId: question.id, sessionId: service.sessionId, createdAt: 0, command: { v: 1, type: 'turn.start', clientRequestId: id, payload: { inputs: [{ type: 'text', text: 'original' }], originator: 'chatgpt' } } })
    await client.connect(interview, 'fixture-token', callbacks)
    // Simulate a stale controller reference; the recovered outcome must still prevent a duplicate.
    repository.saveQuestion({ ...question, status: 'generating' })
    expect(await client.send(question, 'different text', new AbortController().signal)).toEqual({ text: 'Stored server final', turnId })
    expect(service.received.filter(row => row.type === 'turn.start')).toHaveLength(0)
  })

  it('preserves an active turn and durable cancel after cancellation command rejection', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.cancelRejection = 'Assigned worker is unavailable'
    await client.connect(interview, 'fixture-token', callbacks)
    const answer = client.send(question, 'original question', new AbortController().signal)
    const rejected = expect(answer).rejects.toThrow('сохранён для восстановления')
    await vi.waitFor(() => expect(service.rows.size).toBe(1))
    await expect(client.cancel()).rejects.toThrow('сохранён для восстановления')
    await rejected
    expect(repository.listPending(interview.id).map(row => (row.command as Wire).type).sort()).toEqual(['turn.cancel', 'turn.start'])
    expect(repository.listQuestions(interview.id)[0]!.status).toBe('interrupted')
    await expect(client.send({ ...question, id: 'different-question' }, 'next', new AbortController().signal)).rejects.toThrow('предыдущего')
    const requestId = [...service.rows.keys()][0]!
    service.complete(requestId, 'Generation continued and completed')
    await vi.waitFor(() => expect(repository.listPending(interview.id)).toHaveLength(0))
    expect((await client.send(question, 'must not be sent', new AbortController().signal)).text).toBe('Generation continued and completed')
    expect(service.rows.size).toBe(1)
  })

  it('preserves an unacknowledged request for an uncorrelated unknown protocol error', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.startRejection = 'Internal server error'
    await client.connect(interview, 'fixture-token', callbacks)
    await expect(client.send(question, 'original', new AbortController().signal)).rejects.toThrow('сохранён для восстановления')
    const originalId = repository.listPending(interview.id)[0]!.id
    service.startRejection = undefined
    service.onTurn = request => service.complete(request.clientRequestId, 'Recovered')
    expect((await client.send(question, 'changed text', new AbortController().signal)).text).toBe('Recovered')
    expect([...service.rows.keys()]).toEqual([originalId])
  })

  it('clears a confirmed pre-admission quota rejection without claiming a turn was cancelled', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    service.startRejection = 'Daily turn quota exhausted'
    await client.connect(interview, 'fixture-token', callbacks)
    await expect(client.send(question, 'question', new AbortController().signal)).rejects.toThrow('quota')
    expect(repository.listPending(interview.id)).toHaveLength(0)
    expect(repository.listQuestions(interview.id)[0]!.status).toBe('failed')
    expect(service.rows.size).toBe(0)
  })

  it('updates each message item in its original order and keeps the final answer authoritative', async () => {
    const { service, interview, question, client, callbacks } = await setup()
    service.onTurn = (request, _socket, id) => {
      service.emit('codex.event', { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'First' } }, id)
      service.emit('codex.event', { type: 'item.updated', item: { id: 'b', type: 'agent_message', text: 'Second' } }, id)
      service.emit('codex.event', { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'First revised' } }, id)
      service.emit('codex.event', { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Second' } }, id)
      service.complete(request.clientRequestId, 'Authoritative final')
    }
    await client.connect(interview, 'fixture-token', callbacks)
    expect((await client.send(question, 'question', new AbortController().signal)).text).toBe('Authoritative final')
    expect(callbacks.onPartial.mock.calls.map(row => row[1])).toEqual(['', 'First', 'First\n\nSecond', 'First revised\n\nSecond', 'First revised\n\nSecond'])
  })

  it('loads ordered message snapshots from local metadata after restarting the client', async () => {
    const { service, repository, interview, question, client, callbacks } = await setup()
    repository.savePending({ id: `answer-items:${question.id}`, interviewId: interview.id, questionId: question.id, createdAt: 0, command: { type: 'local.answer-items', items: [['a', 'First'], ['b', 'Second']] } })
    service.onTurn = (request, _socket, id) => {
      service.emit('codex.event', { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'First revised' } }, id)
      service.complete(request.clientRequestId, 'Complete')
    }
    await client.connect(interview, 'fixture-token', callbacks)
    await client.send(question, 'question', new AbortController().signal)
    expect(callbacks.onPartial).toHaveBeenLastCalledWith(question.id, 'First revised\n\nSecond', expect.any(String))
    expect(service.received.some(row => row.type === 'local.answer-items')).toBe(false)
    expect(repository.listPending(interview.id)).toHaveLength(0)
  })
})
