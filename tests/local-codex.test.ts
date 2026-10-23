import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Interview, type Question } from '../src/domain/types'
import { LocalCodexClient } from '../src/adapters/ai/local-codex'
import { CodexRpcError, type NativeTurn } from '../src/adapters/ai/local-protocol'
import type { CodexTransport } from '../src/adapters/ai/codex-rpc'
import { MemoryStore } from './helpers/memory-store'

class RpcFixture implements CodexTransport {
  onNotification: CodexTransport['onNotification'] = () => {}
  onDisconnect = () => {}
  turns: NativeTurn[] = []
  failStart = false
  failResume = false
  interruptFailures = 0
  emptyHistoryReads = 0
  account: unknown = { type: 'chatgpt' }
  disposed = false
  request = vi.fn(async (method: string, params: any): Promise<unknown> => {
    if (method === 'account/read') return { account: this.account }
    if (method === 'model/list') return { data: [{ id: 'sol', model: 'gpt-5.6-sol', displayName: 'Sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null }
    if (method === 'config/read') return { config: { mcp_servers: { private: { enabled: true } } } }
    if (method === 'thread/start') return { thread: { id: 'thread' } }
    if (method === 'thread/resume') { if (this.failResume) throw new CodexRpcError(-32600, 'thread not found'); return { thread: { id: 'thread' } } }
    if (method === 'thread/name/set') return {}
    if (method === 'thread/turns/list') { if (this.emptyHistoryReads-- > 0) throw new CodexRpcError(-32603, 'rollout at fixture.jsonl is empty'); return { data: this.turns.map(row => ({ ...row, items: [] })), nextCursor: null } }
    if (method === 'thread/items/list') return { data: this.turns.find(row => row.id === params.turnId)?.items.map(item => ({ turnId: params.turnId, item })) ?? [], nextCursor: null }
    if (method === 'turn/start') {
      if (this.failStart) throw new Error('Connection lost before ack')
      const turn: NativeTurn = { id: 'turn', status: 'inProgress', items: [{ type: 'userMessage', id: 'user', clientId: params.clientUserMessageId }] }
      this.turns.push(turn)
      return { turn }
    }
    if (method === 'turn/interrupt') { if (this.interruptFailures-- > 0) throw new CodexRpcError(-32600, 'no active turn to interrupt'); this.turns[0]!.status = 'interrupted'; return {} }
    throw new Error(`Unsupported fixture method: ${method}`)
  })
  async dispose() { this.disposed = true }
  emit(method: string, params: Record<string, unknown>) { this.onNotification(method, { threadId: 'thread', ...params }) }
}
const clients: LocalCodexClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })
function fixture() {
  const store = new MemoryStore(), rpc = new RpcFixture()
  const interview: Interview = { ...structuredClone(DEFAULT_SETTINGS), provider: 'local', id: 'interview', title: 'Local interview', createdAt: 0, updatedAt: 0, completed: false, remote: { openRequestId: 'open', lastSequence: 0, contextSent: false } }
  const question: Question = { id: 'question', interviewId: interview.id, order: 1, createdAt: 0, status: 'generating', text: 'Question', answer: '', segments: [], partial: false }
  store.saveInterview(interview); store.saveQuestion(question)
  const make = () => { const client = new LocalCodexClient(store, { directory: 'C:\\isolated workspace', discover: async () => ({ executablePath: 'C:\\Codex path\\codex.exe', version: '0.154.0-alpha.6.2' }), launch: async () => rpc }); clients.push(client); return client }
  const callbacks = { onConnection: vi.fn(), onRemote: vi.fn(), onPartial: vi.fn() }
  return { store, rpc, interview, question, make, callbacks }
}
describe('native Codex adapter', () => {
  it('probes without creating threads and reports unavailable auth/model without replacement', async () => {
    const f = fixture(), client = f.make()
    f.rpc.account = null
    expect((await client.probe({ ...DEFAULT_SETTINGS, provider: 'local' })).message).toContain('codex login')
    expect(f.rpc.request.mock.calls.some(([method]) => method.startsWith('thread/'))).toBe(false)
    f.rpc.account = { type: 'chatgpt' }
    expect((await client.probe({ ...DEFAULT_SETTINGS, localCodex: { executablePath: '', model: 'unavailable' } })).status).toBe('error')
  })
  it('persists before sending, disables inherited MCP, replaces answer blocks and excludes reasoning', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    const config = f.rpc.request.mock.calls.find(([method]) => method === 'thread/start')![1].config
    expect(config.mcp_servers.private.enabled).toBe(false)
    expect(config['features.hooks']).toBe(false)
    const send = client.send(f.question, 'Immutable prompt', new AbortController().signal)
    await vi.waitFor(() => expect(f.store.listPending('interview')).toHaveLength(1))
    const pending = f.store.listPending('interview')[0]!
    expect((pending.command as any).params.input[0].text).toBe('Immutable prompt')
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.turnId).toBe('turn'))
    f.rpc.emit('item/started', { turnId: 'turn', item: { type: 'agentMessage', id: 'a', text: '', phase: 'final_answer' } })
    f.rpc.emit('item/agentMessage/delta', { turnId: 'turn', itemId: 'a', delta: 'First' })
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.answer).toBe('First'))
    const complete = { turnId: 'turn', item: { type: 'agentMessage', id: 'a', text: 'Corrected', phase: 'final_answer' } }
    f.rpc.emit('item/completed', complete); f.rpc.emit('item/completed', complete)
    f.rpc.emit('item/completed', { turnId: 'turn', item: { type: 'reasoning', id: 'r', text: 'PRIVATE_REASONING' } })
    f.rpc.turns[0]!.items.push(complete.item)
    f.rpc.turns[0]!.status = 'completed'
    f.rpc.emit('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } })
    expect(await send).toEqual({ text: 'Corrected', turnId: 'turn' })
    expect(f.store.listPending('interview')).toHaveLength(0)
    expect(f.store.listQuestions('interview')[0]?.answer).not.toContain('PRIVATE')
  })
  it('does not resend ambiguously delivered commands after reconnecting', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    f.rpc.failStart = true
    await expect(client.send(f.question, 'Original', new AbortController().signal)).rejects.toThrow('before ack')
    expect(f.store.listPending('interview')).toHaveLength(1)
    await client.dispose()
    const restored = f.make()
    await restored.connect(f.store.getInterview('interview')!, f.callbacks)
    expect(f.store.listPending('interview')).toHaveLength(0)
    expect(f.store.listQuestions('interview')[0]?.status).toBe('interrupted')
    expect(f.store.listQuestions('interview')[0]?.error).toContain('вручную')
    await expect(restored.send(f.question, 'Automatic retry forbidden', new AbortController().signal)).rejects.toThrow('Автоматический повтор отключён')
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })
  it('matches durable clientId when acknowledgement was lost and recovers final without generation', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    f.rpc.failStart = true
    await expect(client.send(f.question, 'Original', new AbortController().signal)).rejects.toThrow()
    const id = f.store.listPending('interview')[0]!.id
    f.rpc.turns = [{ id: 'accepted', status: 'completed', items: [{ type: 'userMessage', id: 'user', clientId: id }, { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'Durable answer' }] }]
    await client.dispose()
    await f.make().connect(f.store.getInterview('interview')!, f.callbacks)
    expect(f.store.listQuestions('interview')[0]).toMatchObject({ status: 'completed', answer: 'Durable answer', turnId: 'accepted' })
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })
  it('keeps an acknowledged active turn recoverable after transport loss and cancels it', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    const send = client.send(f.question, 'Original', new AbortController().signal)
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.turnId).toBe('turn'))
    f.rpc.onDisconnect()
    await expect(send).rejects.toThrow('отключился')
    const restored = f.make()
    await restored.connect(f.store.getInterview('interview')!, f.callbacks)
    const waiting = restored.send(f.store.listQuestions('interview')[0]!, 'Must not send', new AbortController().signal)
    void waiting.catch(() => {})
    await restored.cancel()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.store.listPending('interview')).toHaveLength(0)
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })
  it('requires explicit continuation before recreating a deleted thread', async () => {
    const f = fixture(), client = f.make()
    f.interview.remote.threadId = 'deleted'; f.interview.remote.contextSent = true
    f.rpc.failResume = true
    await expect(client.connect(f.interview, f.callbacks)).rejects.toThrow('Продолжить подключение')
    await client.connect(f.interview, f.callbacks, { allowRecreate: true })
    expect(f.store.getInterview('interview')?.remote.contextSent).toBe(false)
    expect(f.store.getInterview('interview')?.remote.threadId).toBe('thread')
  })
  it('keeps recovered answer blocks when deltas continue an active turn', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    const send = client.send(f.question, 'Original', new AbortController().signal)
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.turnId).toBe('turn'))
    f.rpc.turns[0]!.items.push(
      { type: 'agentMessage', id: 'a', phase: 'final_answer', text: 'Начало' },
      { type: 'agentMessage', id: 'b', phase: 'final_answer', text: 'Вторая часть' }
    )
    f.rpc.onDisconnect()
    await expect(send).rejects.toThrow('отключился')
    const restored = f.make()
    await restored.connect(f.store.getInterview('interview')!, f.callbacks)
    const waiting = restored.send(f.store.listQuestions('interview')[0]!, 'Must not send', new AbortController().signal)
    void waiting.catch(() => {})
    await vi.waitFor(() => expect(f.callbacks.onPartial).toHaveBeenLastCalledWith('question', 'Начало\n\nВторая часть', 'turn'))
    // send() re-reads history before following the existing turn.
    await vi.waitFor(() => expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/items/list').length).toBeGreaterThanOrEqual(2))
    f.rpc.emit('item/agentMessage/delta', { turnId: 'turn', itemId: 'b', delta: ' продолжена' })
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.answer).toBe('Начало\n\nВторая часть продолжена'))
    expect(f.callbacks.onPartial).toHaveBeenLastCalledWith('question', 'Начало\n\nВторая часть продолжена', 'turn')
    f.rpc.onDisconnect()
    await expect(waiting).rejects.toThrow('отключился')
    expect(f.store.listQuestions('interview')[0]?.answer).toBe('Начало\n\nВторая часть продолжена')
    expect(f.store.listPending('interview')).toHaveLength(1)
    f.rpc.turns[0]!.items[2]!.text = 'Вторая часть продолжена'
    f.rpc.turns[0]!.status = 'completed'
    await f.make().connect(f.store.getInterview('interview')!, f.callbacks)
    expect(f.store.listQuestions('interview')[0]).toMatchObject({ status: 'completed', answer: 'Начало\n\nВторая часть продолжена', turnId: 'turn' })
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })
  it('retries cancellation admission and transient empty history without clearing the outbox early', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    const send = client.send(f.question, 'Original', new AbortController().signal)
    void send.catch(() => {})
    await vi.waitFor(() => expect(f.store.listQuestions('interview')[0]?.turnId).toBe('turn'))
    f.rpc.interruptFailures = 1; f.rpc.emptyHistoryReads = 1
    const cancel = client.cancel()
    expect(f.store.listPending('interview')).toHaveLength(1)
    await cancel
    await expect(send).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.store.listPending('interview')).toHaveLength(0)
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(2)
  })
  it('rejects unknown protocol instead of accepting a malformed response', async () => {
    const f = fixture(), client = f.make()
    f.rpc.request.mockResolvedValueOnce({ auth: true })
    await expect(client.connect(f.interview, f.callbacks)).rejects.toThrow('несовместимый')
  })
  it('unloads only its own idle transport after five minutes', async () => {
    const f = fixture(), client = f.make()
    await client.connect(f.interview, f.callbacks)
    vi.useFakeTimers()
    try {
      await client.connect(f.store.getInterview('interview')!, f.callbacks)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(f.rpc.disposed).toBe(true)
      expect(f.callbacks.onConnection).toHaveBeenLastCalledWith('disconnected')
      expect(f.store.getInterview('interview')?.remote.threadId).toBe('thread')
    } finally { vi.useRealTimers() }
  })
})
