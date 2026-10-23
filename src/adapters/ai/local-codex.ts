import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AiAnswer, AiSessionCallbacks, AiSessionPort, InterviewRepository } from '../../domain/ports'
import type { AiReadiness, Interview, PendingCommand, Question, Settings } from '../../domain/types'
import { discoverCodex } from './codex-discovery'
import { CodexRpc, LOCAL_OVERRIDES, type CodexTransport } from './codex-rpc'
import { AccountResponse, CodexRpcError, ItemsPage, LocalStart, ModelsPage, ThreadResponse, Turn, TurnsPage, parseProtocol, type NativeItem, type NativeTurn } from './local-protocol'

// Kept in sync with the published interview-assistant@2 instructions; no sibling imports.
export const INTERVIEW_INSTRUCTIONS = [
  'Ты помогаешь кандидату быстро сформулировать ответ на вопрос собеседования.',
  'Дай готовую к произнесению подсказку на языке вопроса с учетом переданного профиля кандидата и вакансии.',
  'Начинай сразу с прямого ответа. По умолчанию достаточно 20–35 слов: одна короткая мысль и до двух опорных пунктов.',
  'Если пользователь явно просит подробности или код, дай необходимое пояснение или минимальный пример кода.',
  'Не добавляй вступления, предложения продолжить, перечни альтернатив и повтор вопроса.',
  'Не выдумывай опыт кандидата или неизвестные факты. При существенной неоднозначности коротко обозначь допущение.',
  'Не используй инструменты, команды, файлы, браузер или сеть. Код приводи только как текст.'
].join('\n')
const ambiguous = 'Доставка запроса не подтверждена историей Codex. Автоматический повтор отключён; проверьте частичный ответ и отправьте вопрос повторно вручную.'
const aborted = () => Object.assign(new Error('Запрос отменён'), { name: 'AbortError' })
type Active = { question: Question; turnId?: string; resolve(answer: AiAnswer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void; cancelling?: Promise<void> }
export interface LocalCodexOptions {
  directory: string; idleMs?: number; responseMs?: number
  discover?: typeof discoverCodex
  launch?: (path: string, directory: string, signal?: AbortSignal) => Promise<CodexTransport>
}

export class LocalCodexClient implements AiSessionPort {
  private rpc?: CodexTransport
  private interview?: Interview
  private callbacks?: AiSessionCallbacks
  private active?: Active
  private blocks = new Map<string, NativeItem>()
  private connecting?: Promise<void>
  private stopping: Promise<void> = Promise.resolve()
  private idle?: ReturnType<typeof setTimeout>
  private epoch = 0
  private events = Promise.resolve()
  private found?: Awaited<ReturnType<typeof discoverCodex>>
  private startupAbort?: AbortController
  private probes = new Set<LocalCodexClient>()
  constructor(private readonly repository: InterviewRepository, private readonly options: LocalCodexOptions) {}

  private async start(path: string): Promise<CodexTransport> {
    const startup = new AbortController(); this.startupAbort = startup
    await this.stopping
    this.found = await (this.options.discover ?? discoverCodex)(path)
    startup.signal.throwIfAborted()
    return (this.options.launch ?? CodexRpc.start)(this.found.executablePath, this.options.directory, startup.signal)
  }
  private async inspect(rpc: CodexTransport, model: string): Promise<AiReadiness> {
    const account = parseProtocol(AccountResponse, await rpc.request('account/read', { refreshToken: false }))
    const authenticated = account.account?.type === 'chatgpt' || account.account?.type === 'chatgptAuthTokens'
    if (!authenticated) return { provider: 'local', status: 'error', ...this.found, authenticated: false, models: [], message: 'Войдите через установленный Codex с учётной записью ChatGPT: выполните codex login. Затем повторите проверку.' }
    const models: NonNullable<AiReadiness['models']> = []
    let cursor: string | null = null
    for (let page = 0; page < 30; page++) {
      const result: z.infer<typeof ModelsPage> = parseProtocol(ModelsPage, await rpc.request('model/list', { cursor, limit: 100 }))
      models.push(...result.data.filter(row => !row.hidden).map(row => ({ id: row.model, label: row.displayName, supportsLow: row.supportedReasoningEfforts.some(e => e.reasoningEffort === 'low') })))
      cursor = result.nextCursor
      if (!cursor) break
    }
    const available = models.some(row => row.id === model && row.supportsLow)
    return { provider: 'local', status: authenticated && available ? 'ready' : 'error', ...this.found, authenticated, models,
      message: !authenticated ? 'Войдите через установленный Codex с учётной записью ChatGPT: выполните codex login. Затем повторите проверку.' : !available ? `Модель ${model} с reasoning low недоступна. Выберите другую модель и сохраните настройки.` : 'Локальный Codex готов. Используется авторизация ChatGPT.' }
  }
  async probe(settings: Settings): Promise<AiReadiness> {
    // A separate process; no thread/start and no interference with the active session.
    const inspector = new LocalCodexClient(this.repository, this.options)
    this.probes.add(inspector)
    let rpc: CodexTransport | undefined
    try { rpc = await inspector.start(settings.localCodex.executablePath); inspector.rpc = rpc; return await inspector.inspect(rpc, settings.localCodex.model) }
    catch (error) { return { provider: 'local', status: 'error', ...inspector.found, message: error instanceof Error ? error.message : 'Не удалось проверить Codex.' } }
    finally { await inspector.dispose(); this.probes.delete(inspector) }
  }
  async connect(interview: Interview, callbacks: AiSessionCallbacks, options?: { allowRecreate?: boolean }): Promise<void> {
    if (this.interview?.id !== interview.id) { this.disconnect(); await this.connecting?.catch(() => undefined); this.interview = structuredClone(interview) }
    this.callbacks = callbacks
    clearTimeout(this.idle)
    if (this.connecting) return this.connecting
    if (this.rpc) { this.armIdle(); return }
    this.interview = structuredClone(interview)
    const epoch = this.epoch
    this.connecting = this.open(options?.allowRecreate ?? false, epoch).finally(() => { this.connecting = undefined })
    try { await this.connecting } catch (error) {
      if (epoch === this.epoch) { this.callbacks?.onConnection('error', error instanceof Error ? error.message : 'Codex недоступен'); await this.stopTransport() }
      throw error
    }
  }
  private async open(allowRecreate: boolean, epoch: number): Promise<void> {
    const interview = this.interview!
    this.callbacks?.onConnection(interview.remote.threadId ? 'recovering' : 'connecting')
    const rpc = await this.start(interview.localCodex.executablePath)
    if (epoch !== this.epoch) { await rpc.dispose(); throw aborted() }
    this.rpc = rpc
    const readiness = await this.inspect(rpc, interview.localCodex.model)
    if (readiness.status !== 'ready') throw new Error(readiness.message)
    const config = parseProtocol(z.object({ config: z.record(z.unknown()) }), await rpc.request('config/read', { includeLayers: false, cwd: this.options.directory })).config
    const overrides = { ...LOCAL_OVERRIDES }
    // Per-name disables override inherited tables, whereas mcp_servers={} would merge.
    const servers = z.record(z.unknown()).safeParse(config.mcp_servers)
    if (servers.success) overrides.mcp_servers = Object.fromEntries(Object.keys(servers.data).map(name => [name, { enabled: false }]))
    const params = { model: interview.localCodex.model, modelProvider: 'openai', serviceTier: 'default', cwd: this.options.directory, approvalPolicy: 'never', sandbox: 'read-only', config: overrides,
      baseInstructions: INTERVIEW_INSTRUCTIONS, developerInstructions: 'Отвечай кратко на языке вопроса. Код показывай как текст без запуска.' }
    rpc.onNotification = (method, value) => {
      this.events = this.events.then(() => epoch === this.epoch ? this.notification(method, value) : undefined).catch(() => {
        if (epoch === this.epoch) this.lost('Некорректное событие Codex. Продолжите интервью для сверки запроса.')
      })
    }
    rpc.onDisconnect = () => { if (epoch === this.epoch) this.lost('Локальный Codex отключился. Продолжите интервью для сверки запроса.') }
    let threadId = interview.remote.threadId
    if (threadId) {
      try { parseProtocol(ThreadResponse, await rpc.request('thread/resume', { ...params, threadId, excludeTurns: true })) }
      catch (error) {
        if (!(error instanceof CodexRpcError) || !/(thread.*(?:not found|does not exist)|no rollout|unknown thread|unable to find thread)/i.test(error.detail)) throw error
        if (!allowRecreate) throw new Error('Сохранённый thread Codex удалён. Нажмите «Продолжить подключение», чтобы восстановить контекст в новой сессии.')
        for (const pending of this.pending()) this.interruptPending(pending, 'Сохранённый thread Codex удалён. Отправьте вопрос повторно вручную.')
        threadId = undefined; interview.remote.contextSent = false
      }
    }
    if (!threadId) {
      threadId = parseProtocol(ThreadResponse, await rpc.request('thread/start', { ...params, ephemeral: false })).thread.id
      await rpc.request('thread/name/set', { threadId, name: `Work Search · ${interview.title}` })
    }
    if (epoch !== this.epoch) throw aborted()
    interview.remote.threadId = threadId; interview.remote.cliVersion = this.found?.version
    this.saveRemote()
    await this.reconcile()
    if (epoch !== this.epoch) throw aborted()
    this.callbacks?.onConnection('ready'); this.armIdle()
  }
  private async items(turnId: string): Promise<NativeItem[]> {
    let cursor: string | null = null
    const items: NativeItem[] = []
    for (let page = 0; page < 100; page++) {
      const result: z.infer<typeof ItemsPage> = parseProtocol(ItemsPage, await this.historyRequest('thread/items/list', { threadId: this.interview!.remote.threadId, turnId, cursor, limit: 100, sortDirection: 'asc' }))
      items.push(...result.data.filter(row => row.turnId === turnId).map(row => row.item))
      if (!result.nextCursor) return items
      if (cursor === result.nextCursor) break
      cursor = result.nextCursor
    }
    throw new Error('История Codex слишком велика или имеет некорректный курсор. Повтор запроса приостановлен.')
  }
  private async turns(): Promise<NativeTurn[]> {
    const result: NativeTurn[] = []
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const rows: z.infer<typeof TurnsPage> = parseProtocol(TurnsPage, await this.historyRequest('thread/turns/list', { threadId: this.interview!.remote.threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' }))
      result.push(...rows.data)
      if (!rows.nextCursor) return result
      if (cursor === rows.nextCursor) break
      cursor = rows.nextCursor
    }
    throw new Error('Не удалось полностью сверить историю Codex. Повтор запроса приостановлен.')
  }
  private async historyRequest(method: string, params: unknown): Promise<unknown> {
    // Native lifecycle notifications can precede the first durable rollout flush.
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.rpc) throw new Error('Codex отключён. Продолжите интервью для сверки истории.')
        return await this.rpc.request(method, params)
      } catch (error) {
        if (attempt >= 20 || !(error instanceof CodexRpcError) || !/(not materialized|rollout .* is empty)/i.test(error.detail)) throw error
        await new Promise(done => setTimeout(done, 100))
      }
    }
  }
  private async reconcile(): Promise<void> {
    const pending = this.pending()
    if (!pending.length) return
    const turns = await this.turns()
    for (const row of pending) {
      const question = this.question(row.questionId)
      if (!question) throw new Error('Вопрос ожидающей команды не найден.')
      let matched: NativeTurn | undefined
      for (const turn of turns) {
        if (question.turnId && turn.id !== question.turnId) continue
        const items = await this.items(turn.id)
        if (question.turnId === turn.id || items.some(item => item.type === 'userMessage' && item.clientId === row.id)) { matched = { ...turn, items }; break }
      }
      if (!matched) { this.interview!.remote.deliveryUncertain = true; this.saveRemote(); this.interruptPending(row, ambiguous) }
      else this.applyTurn(question, matched)
    }
  }
  async send(question: Question, text: string, signal: AbortSignal): Promise<AiAnswer> {
    if (signal.aborted) throw aborted()
    if (!this.rpc || !this.interview || question.interviewId !== this.interview.id) throw new Error('Локальный Codex не подключён к этому интервью.')
    if (this.active) throw new Error('Предыдущий запрос ещё выполняется.')
    if (this.interview.remote.deliveryUncertain) throw new Error(ambiguous)
    const stored = this.question(question.id)
    if (stored?.status === 'completed' && stored.turnId) return { text: stored.answer, turnId: stored.turnId }
    const pending = this.pending()
    if (pending.some(row => row.questionId !== question.id)) throw new Error('Сначала сверьте предыдущий запрос Codex.')
    const prior = pending.find(row => row.questionId === question.id)
    if (prior && !stored?.turnId) throw new Error(ambiguous)
    if (!prior && !text.trim()) throw new Error('Вопрос не должен быть пустым.')
    clearTimeout(this.idle); this.blocks.clear()
    let resolve!: Active['resolve'], reject!: Active['reject']
    const promise = new Promise<AiAnswer>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => undefined)
    const onAbort = () => { void this.cancel().catch(error => this.fail(error instanceof Error ? error : aborted())) }
    const active: Active = { question, turnId: prior ? stored?.turnId : undefined, resolve, reject,
      timer: setTimeout(() => { void this.cancel().catch(() => undefined); this.fail(new Error('Codex не завершил ответ за 120 секунд. Продолжите интервью для сверки запроса.')) }, this.options.responseMs ?? 120_000),
      cleanup: () => signal.removeEventListener('abort', onAbort) }
    this.active = active; signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (prior) {
        const turn = (await this.turns()).find(row => row.id === active.turnId)
        if (!turn) throw new Error(ambiguous)
        this.applyTurn(question, { ...turn, items: await this.items(turn.id) })
      } else {
        const id = randomUUID()
        const command = parseProtocol(LocalStart, { type: 'turn.start', method: 'turn/start', params: { threadId: this.interview.remote.threadId, clientUserMessageId: id, input: [{ type: 'text', text, text_elements: [] }], model: this.interview.localCodex.model, effort: 'low', summary: 'none', serviceTierForTurn: 'default' } })
        this.repository.savePending({ provider: 'local', id, interviewId: question.interviewId, questionId: question.id, command, createdAt: Date.now() })
        const response = parseProtocol(z.object({ turn: Turn }), await this.rpc.request(command.method, command.params))
        if (this.active === active) { active.turnId = response.turn.id; this.applyTurn(question, response.turn) }
      }
      if (signal.aborted && this.active === active) await this.cancel()
    } catch (error) {
      // The native protocol does not promise idempotent delivery. Keep the outbox on any ambiguous failure.
      if (error instanceof CodexRpcError && [-32601, -32602].includes(error.code)) {
        for (const row of this.pending().filter(row => row.questionId === question.id)) this.interruptPending(row, error.message)
      }
      this.fail(error instanceof Error ? error : new Error('Ошибка локального Codex.'))
    }
    return promise
  }
  private async notification(method: string, value: unknown): Promise<void> {
    if (!this.interview) return
    const base = z.object({ threadId: z.string() }).passthrough().safeParse(value)
    if (!base.success || base.data.threadId !== this.interview.remote.threadId) return
    if (method === 'turn/started' || method === 'turn/completed') {
      const data = parseProtocol(z.object({ turn: Turn }), value)
      const question = this.active?.question ?? this.repository.listQuestions(this.interview.id).find(q => q.turnId === data.turn.id && this.pending().some(p => p.questionId === q.id))
      if (!question || (this.active?.turnId && this.active.turnId !== data.turn.id)) return
      if (this.active) this.active.turnId = data.turn.id
      // Terminal notifications can omit items. Paginated history is authoritative.
      const turn = method === 'turn/completed' ? { ...data.turn, items: await this.items(data.turn.id) } : data.turn
      this.applyTurn(question, turn)
    } else if (['item/started', 'item/completed'].includes(method)) {
      const data = parseProtocol(z.object({ turnId: z.string(), item: z.object({ type: z.string(), id: z.string() }).passthrough() }), value)
      if (!this.active || data.turnId !== this.active.turnId) return
      const item = data.item as NativeItem
      if (item.type !== 'agentMessage') return
      this.blocks.set(item.id, item); this.partial()
    } else if (method === 'item/agentMessage/delta') {
      const data = parseProtocol(z.object({ turnId: z.string(), itemId: z.string(), delta: z.string() }), value)
      if (!this.active || this.active.turnId !== data.turnId) return
      const prior = this.blocks.get(data.itemId)
      // Native deltas are accumulated inside one block; snapshots/completion replace that block.
      this.blocks.set(data.itemId, { ...prior, type: 'agentMessage', id: data.itemId, text: (prior?.text ?? '') + data.delta }); this.partial()
    }
  }
  private answer(items: Iterable<NativeItem>): string {
    return [...items].filter(row => row.type === 'agentMessage' && (!row.phase || row.phase === 'final_answer')).map(row => row.text ?? '').filter(Boolean).join('\n\n')
  }
  private partial(): void {
    const active = this.active
    if (!active) return
    const question = this.question(active.question.id) ?? active.question
    const answer = this.answer(this.blocks.values())
    if (answer === question.answer) return
    this.repository.saveQuestion({ ...question, answer, turnId: active.turnId })
    this.callbacks?.onPartial(question.id, answer, active.turnId)
  }
  private applyTurn(question: Question, turn: NativeTurn): void {
    // A resumed turn's snapshots seed the same blocks used by subsequent deltas.
    if (this.active?.question.id === question.id) {
      for (const item of turn.items) if (item.type === 'agentMessage') this.blocks.set(item.id, item)
    }
    const current = this.question(question.id) ?? question
    const terminal = turn.status !== 'inProgress'
    const answer = this.answer(new Map(turn.items.map(item => [item.id, item])).values())
    const resolvedAnswer = turn.status === 'completed' ? answer : answer || current.answer
    this.repository.transaction(() => {
      this.repository.saveQuestion({ ...current, turnId: turn.id, answer: resolvedAnswer,
        status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : turn.status === 'failed' ? 'failed' : 'generating',
        error: turn.status === 'failed' ? 'Codex не смог завершить запрос. Проверьте доступность модели и лимиты аккаунта.' : undefined })
      this.interview!.remote.contextSent = true; this.saveRemote()
      if (terminal) for (const row of this.pending().filter(row => row.questionId === question.id)) this.repository.deletePending(row.id)
    })
    this.callbacks?.onPartial(question.id, resolvedAnswer, turn.id)
    if (this.active?.question.id === question.id) {
      this.active.turnId = turn.id
      if (terminal) {
        if (turn.status === 'completed') this.finish({ text: resolvedAnswer, turnId: turn.id })
        else this.fail(turn.status === 'interrupted' ? aborted() : new Error('Codex не смог завершить запрос.'))
      }
    }
  }
  private interruptPending(row: PendingCommand, message: string): void {
    this.repository.transaction(() => {
      const question = this.question(row.questionId)
      if (question) this.repository.saveQuestion({ ...question, status: 'interrupted', error: message })
      this.repository.deletePending(row.id)
    })
  }
  private pending(): PendingCommand[] { return this.interview ? this.repository.listPending(this.interview.id).filter(row => row.provider === 'local' && LocalStart.safeParse(row.command).success) : [] }
  private question(id?: string): Question | undefined { return this.interview && this.repository.listQuestions(this.interview.id).find(row => row.id === id) }
  private saveRemote(): void {
    const interview = this.interview!
    this.repository.saveInterview({ ...(this.repository.getInterview(interview.id) ?? interview), remote: structuredClone(interview.remote) })
    this.callbacks?.onRemote(structuredClone(interview.remote))
  }
  async cancel(): Promise<void> {
    const active = this.active
    if (!active) return
    if (active.cancelling) return active.cancelling
    return active.cancelling = (async () => {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && this.active === active) {
        if (!this.rpc) throw new Error('Codex отключён. Продолжите интервью для сверки отмены.')
        if (active.turnId) {
          try {
            await this.rpc.request('turn/interrupt', { threadId: this.interview!.remote.threadId, turnId: active.turnId })
          } catch (error) {
            // 0.154 can acknowledge turn/start before making the turn interruptible.
            if (!(error instanceof CodexRpcError) || !/no active turn to interrupt/i.test(error.detail)) throw error
          }
          if (this.active !== active) return
          try {
            const turn = (await this.turns()).find(row => row.id === active.turnId)
            if (turn && turn.status !== 'inProgress') this.applyTurn(active.question, { ...turn, items: await this.items(turn.id) })
          } catch (error) {
            if (!(error instanceof CodexRpcError) || !/not materialized/i.test(error.detail)) throw error
          }
        }
        if (this.active === active) await new Promise(done => setTimeout(done, 150))
      }
      if (this.active === active) throw new Error('Codex ещё не подтвердил отмену. Продолжите интервью для сверки.')
    })().finally(() => { active.cancelling = undefined })
  }
  private finish(answer: AiAnswer): void { const active = this.active; if (!active) return; this.clearActive(); active.resolve(answer) }
  private fail(error: Error): void { const active = this.active; if (!active) return; this.clearActive(); active.reject(error) }
  private clearActive(): void { if (this.active) { clearTimeout(this.active.timer); this.active.cleanup(); this.active = undefined }; this.armIdle() }
  private armIdle(): void {
    clearTimeout(this.idle)
    if (this.active || !this.rpc) return
    this.idle = setTimeout(() => { if (!this.active) { this.disconnect(); this.callbacks?.onConnection('disconnected') } }, this.options.idleMs ?? 300_000)
    this.idle.unref?.()
  }
  private lost(message: string): void {
    this.fail(new Error(message)); this.callbacks?.onConnection('recovering', message)
    const rpc = this.rpc; this.rpc = undefined; this.stopping = rpc?.dispose() ?? this.stopping
  }
  private async stopTransport(): Promise<void> { const rpc = this.rpc; this.rpc = undefined; await rpc?.dispose() }
  disconnect(): void {
    this.epoch++; this.startupAbort?.abort(); clearTimeout(this.idle); this.fail(new Error('Соединение закрыто. Запрос сохранён для сверки.')); clearTimeout(this.idle)
    const rpc = this.rpc; this.rpc = undefined; this.stopping = rpc?.dispose() ?? this.stopping
  }
  async close(): Promise<void> { await this.cancel(); this.disconnect(); await this.stopping }
  async dispose(): Promise<void> { this.disconnect(); await Promise.all([...this.probes].map(probe => probe.dispose())); await this.connecting?.catch(() => undefined); await this.stopping }
}
