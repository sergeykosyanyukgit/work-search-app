import { randomUUID } from 'node:crypto'
import type { AiSessionPort, AudioCapturePort, InterviewRepository, SecretStore, SettingsRepository, SttPort } from '../domain/ports'
import { MAX_RECORDING_MS, type AppSnapshot, type CaptureResult, type DiagnosticEvent, type Interview, type Question, type Settings } from '../domain/types'
import { assertQueueCapacity, nextAiQuestion, orderedTranscript } from '../domain/queue'
import { buildPrompt } from '../domain/prompt'

type Store = InterviewRepository & SecretStore & SettingsRepository
export class InterviewController {
  private state: AppSnapshot
  private listener: (snapshot: AppSnapshot) => void = () => {}
  private audio = new Map<string, CaptureResult>()
  private recordingId?: string
  private recordingTimer?: ReturnType<typeof setTimeout>
  private sttJob?: { questionId: string; abort: AbortController; promise: Promise<void> }
  private aiJob?: { questionId: string; abort: AbortController; promise: Promise<void> }
  private connectedInterview?: string
  private shuttingDown = false
  private suspending = false
  private deliveryBlocked = false
  private connectionEpoch = 0
  private timings = new Map<string, { inputReadyAt: number; requestSentAt?: number }>()
  private diagnostics: (event: DiagnosticEvent) => void = () => {}

  constructor(private store: Store, private capture: AudioCapturePort, private stt: SttPort, private ai: AiSessionPort, private readonly now: () => number = () => performance.now()) {
    this.state = { settings: store.getSettings(), aiReadiness: { provider: store.getSettings().provider, status: 'unchecked' }, hasToken: !!store.getToken(), questions: [], history: store.listInterviews(), capture: 'idle',
      levels: { microphone: 0, system: 0 }, connection: 'disconnected', stt: stt.getState(), mousePassthrough: false }
    capture.onLevels(levels => { this.state.levels = levels; this.emit() })
    capture.onStopped(result => this.completeCapture(result))
    stt.onState(state => { this.state.stt = state; this.emit() })
  }
  snapshot(): AppSnapshot { return structuredClone(this.state) }
  onChange(listener: (snapshot: AppSnapshot) => void): void { this.listener = listener }
  onDiagnostics(listener: typeof this.diagnostics): void { this.diagnostics = listener }
  private emit(): void { if (!this.shuttingDown) this.listener(this.snapshot()) }
  notify(message?: string): void { this.state.notice = message; this.emit() }
  setShortcutErrors(errors: string[]): void { this.state.shortcutErrors = [...errors]; this.emit() }
  setMousePassthrough(value: boolean): void { this.state.mousePassthrough = value; this.emit() }
  private updateQuestion(question: Question): void {
    const index = this.state.questions.findIndex(q => q.id === question.id)
    if (index >= 0) this.state.questions[index] = question
    this.store.saveQuestion(question)
    if (this.state.interview) {
      this.state.interview.updatedAt = Date.now()
      this.store.saveInterview(this.state.interview)
    }
    this.state.history = this.store.listInterviews()
    this.emit()
  }
  private requireInterview(): Interview {
    if (!this.state.interview || this.state.interview.completed) throw new Error('Начните новое интервью или продолжите сохраненное.')
    return this.state.interview
  }
  private makeQuestion(revisionOf?: string): Question {
    const interview = this.requireInterview()
    assertQueueCapacity(this.state.questions)
    return { id: randomUUID(), interviewId: interview.id, order: Math.max(0, ...this.state.questions.map(q => q.order)) + 1,
      createdAt: Date.now(), status: 'recording', segments: [], text: '', answer: '', partial: false, ...(revisionOf ? { revisionOf } : {}) }
  }
  private async leaveCurrent(close: boolean): Promise<void> {
    this.suspending = true
    this.connectionEpoch++
    try {
    if (this.recordingId) await this.cancel(this.recordingId)
    if (this.sttJob) await this.cancel(this.sttJob.questionId)
    // Leaving is local suspension, not a confirmed remote cancellation. Never
    // reconnect just to leave, and retain the durable request for reconciliation.
    const job = this.aiJob
    const mayClose = close && !job && this.connectedInterview && this.state.connection === 'ready' &&
      !this.store.listPending(this.state.interview!.id).length
    try { if (mayClose) await this.ai.close() } catch { /* Remote expiry can finish cleanup later. */ }
    finally { this.ai.disconnect() }
    job?.abort.abort()
    if (this.aiJob === job) this.aiJob = undefined
    if (job) {
      const question = this.store.listQuestions(this.state.interview!.id).find(q => q.id === job.questionId)
      if (question && !['completed', 'cancelled', 'failed'].includes(question.status)) {
        question.status = this.hasPending(question) ? 'queued' : 'interrupted'
        question.error = this.hasPending(question) ? 'Запрос сохранён. Продолжите интервью для сверки результата.' : 'Интервью приостановлено.'
        this.updateQuestion(question)
      }
    }
    for (const q of this.state.questions.filter(q => ['queued', 'transcribing'].includes(q.status) && !this.hasPending(q))) { q.status = 'interrupted'; q.error = 'Интервью приостановлено. Текст можно отправить повторно.'; this.updateQuestion(q) }
    this.audio.clear()
    this.timings.clear()
    this.connectedInterview = undefined
    this.state.connection = 'disconnected'
    this.deliveryBlocked = false
    } finally { this.suspending = false }
  }
  async newInterview(title?: string): Promise<void> {
    await this.leaveCurrent(true)
    const now = Date.now()
    const settings = this.state.settings
    const interview: Interview = { id: randomUUID(), title: title?.trim() || `Собеседование ${new Date(now).toLocaleString('ru-RU')}`, createdAt: now, updatedAt: now,
      provider: settings.provider, localCodex: structuredClone(settings.localCodex), profile: structuredClone(settings.profile), profileSlug: settings.profileSlug, serviceUrl: settings.serviceUrl,
      remote: { openRequestId: randomUUID(), lastSequence: 0, contextSent: false }, completed: false }
    this.store.saveInterview(interview)
    this.state.interview = interview; this.state.questions = []; this.state.history = this.store.listInterviews(); this.state.notice = undefined
    this.emit()
  }
  async resumeInterview(id: string): Promise<void> {
    if (id === this.state.interview?.id && !this.state.interview.completed) { await this.recoverConnection(); return }
    const interview = this.store.getInterview(id)
    if (!interview) throw new Error('Интервью не найдено.')
    await this.leaveCurrent(true)
    this.state.interview = interview; interview.completed = false; interview.updatedAt = Date.now()
    if (interview.provider === 'local') interview.localCodex.executablePath = this.state.settings.localCodex.executablePath
    this.state.questions = this.store.listQuestions(id)
    this.store.transaction(() => {
      this.store.saveInterview(interview)
      for (const q of this.state.questions) {
        if (['recording', 'transcribing'].includes(q.status)) { q.status = 'interrupted'; q.error = 'Запись прервана завершением приложения; аудио не сохранялось.'; this.store.saveQuestion(q) }
        if (q.status === 'generating' || this.hasPending(q)) { q.status = 'queued'; this.store.saveQuestion(q) }
      }
    })
    this.state.notice = 'Интервью восстановлено. Проверяем незавершенные запросы.'; this.emit()
    try { await this.ensureConnection(true); this.refreshRecoveredQuestions(); this.deliveryBlocked = !!this.state.interview?.remote.deliveryUncertain; this.pump() } catch (error) { this.deliveryBlocked = true; this.notify(this.message(error)) }
  }
  async finishInterview(): Promise<void> {
    const interview = this.requireInterview()
    await this.leaveCurrent(true)
    interview.completed = true; interview.updatedAt = Date.now(); this.store.saveInterview(interview)
    this.state.history = this.store.listInterviews(); this.emit()
  }
  async deleteInterview(id: string): Promise<void> {
    if (this.state.interview?.id === id) { await this.leaveCurrent(true); this.state.interview = undefined; this.state.questions = [] }
    this.store.deleteInterview(id); this.state.history = this.store.listInterviews(); this.emit()
  }
  saveSettings(settings: Settings, token?: string): void {
    const cloudActive = this.state.interview?.provider !== 'local'
    if (token?.trim() && this.aiJob && cloudActive) throw new Error('Перед заменой токена отмените текущий запрос.')
    this.store.transaction(() => {
      this.store.saveSettings(settings)
      if (token?.trim()) this.store.setToken(token.trim())
    })
    this.state.settings = settings; this.state.hasToken = !!this.store.getToken()
    this.state.aiReadiness = { ...(this.state.aiReadiness.provider === settings.provider ? this.state.aiReadiness : {}), provider: settings.provider, status: 'unchecked', message: undefined }
    this.state.notice = 'Настройки сохранены. Провайдер, модель и профиль применяются к новому интервью.'
    if (token?.trim() && cloudActive) { this.ai.disconnect(); this.connectedInterview = undefined; this.state.connection = 'disconnected' }
    this.emit(); this.pump()
  }
  clearToken(): void {
    if (this.aiJob && this.state.interview?.provider !== 'local') throw new Error('Сначала отмените текущий запрос.')
    if (this.state.interview?.provider !== 'local') { this.ai.disconnect(); this.connectedInterview = undefined; this.state.connection = 'disconnected' }
    this.store.clearToken(); this.state.hasToken = false
    if (this.state.settings.provider === 'cloud') this.state.aiReadiness = { provider: 'cloud', status: 'unchecked' }
    this.emit()
  }
  async toggleRecording(): Promise<void> {
    if (this.state.capture === 'starting' || this.state.capture === 'stopping') return
    if (this.recordingId) {
      this.state.capture = 'stopping'; this.emit()
      try { this.completeCapture(await this.capture.stop()) } catch (error) {
        const id = this.recordingId
        await this.capture.cancel().catch(() => {})
        this.resetCapture()
        const q = this.state.questions.find(q => q.id === id)
        if (q) { q.status = 'failed'; q.error = this.message(error); this.updateQuestion(q) }
        this.pump()
      }
      return
    }
    if (!['ready', 'processing'].includes(this.stt.getState().status)) throw new Error('Подготовьте модель Whisper в настройках перед записью.')
    if (!this.state.interview || this.state.interview.completed) await this.newInterview()
    const question = this.makeQuestion()
    this.state.questions.push(question); this.recordingId = question.id; this.state.capture = 'starting'
    this.updateQuestion(question)
    try {
      await this.capture.start(question.id, { sources: this.state.settings.sources, microphoneId: this.state.settings.microphoneId })
      if (this.recordingId !== question.id) return
      this.state.capture = 'recording'; this.state.recordingStartedAt = Date.now()
      this.recordingTimer = setTimeout(() => void this.toggleRecording(), MAX_RECORDING_MS)
      this.emit()
      // Open the AI session while the user speaks; do not add its handshake after STT.
      // Recording and transcription still work if the service is unavailable.
      if (this.canConnect()) void this.ensureConnection().catch(() => undefined)
    } catch (error) {
      await this.capture.cancel().catch(() => {})
      this.resetCapture(); question.status = 'failed'; question.error = this.message(error); this.updateQuestion(question); this.pump()
    }
  }
  private resetCapture(): void {
    clearTimeout(this.recordingTimer); this.recordingTimer = undefined; this.recordingId = undefined
    this.state.capture = 'idle'; this.state.recordingStartedAt = undefined; this.state.levels = { microphone: 0, system: 0 }
  }
  private completeCapture(result: CaptureResult): void {
    if (this.shuttingDown || result.recordingId !== this.recordingId) return
    const question = this.state.questions.find(q => q.id === result.recordingId)
    const durationMs = this.state.recordingStartedAt ? Date.now() - this.state.recordingStartedAt : 0
    this.resetCapture()
    if (!question || question.status !== 'recording') return
    this.diagnostics({ operation: 'capture', result: result.partial ? 'failed' : 'completed', durationMs, questionId: question.id })
    question.status = 'transcribing'; question.partial = result.partial; question.error = result.error
    this.timings.set(question.id, { inputReadyAt: this.now() })
    this.audio.set(question.id, result); this.updateQuestion(question); this.pump()
  }
  async submitText(text: string, revisionOf?: string): Promise<void> {
    if (!text.trim()) throw new Error('Введите текст вопроса.')
    // Starting a new interview is tied to this explicit action, never to app startup.
    // Revisions stay in their original interview and cannot silently create a new one.
    if (!revisionOf && (!this.state.interview || this.state.interview.completed)) await this.newInterview()
    const question = this.makeQuestion(revisionOf)
    if (revisionOf && !this.state.questions.some(q => q.id === revisionOf)) throw new Error('Исходный вопрос не найден в этом интервью.')
    if (this.state.interview?.remote.deliveryUncertain) {
      if (!revisionOf || this.state.questions.find(q => q.id === revisionOf)?.status !== 'interrupted') throw new Error('Сначала подтвердите ручной повтор прерванного вопроса или начните новое интервью.')
      this.state.interview.remote.deliveryUncertain = false; this.store.saveInterview(this.state.interview)
      this.ai.disconnect(); this.connectedInterview = undefined; this.state.connection = 'disconnected'; this.deliveryBlocked = false
    }
    question.text = text.trim(); question.status = 'queued'; this.state.questions.push(question)
    this.timings.set(question.id, { inputReadyAt: this.now() })
    this.updateQuestion(question); this.pump()
  }
  async cancel(id: string): Promise<void> {
    const question = this.state.questions.find(q => q.id === id)
    if (!question) return
    if (question.status === 'completed' || question.status === 'cancelled') return
    if (this.hasPending(question) && this.aiJob?.questionId !== id) throw new Error('Сначала восстановите соединение кнопкой «Продолжить подключение»: AI должен подтвердить отмену отправленного запроса.')
    question.status = 'cancelled'; question.error = undefined; this.updateQuestion(question)
    if (this.recordingId === id) { await this.capture.cancel(); this.resetCapture() }
    this.audio.delete(id)
    if (this.sttJob?.questionId === id) { this.sttJob.abort.abort(); await this.sttJob.promise }
    if (this.aiJob?.questionId === id) {
      this.aiJob.abort.abort()
      try { await this.ai.cancel(); await this.aiJob?.promise }
      catch (error) {
        if (this.hasPending(question)) {
          question.status = 'queued'; question.error = 'Отмена не подтверждена. Восстановите подключение для сверки запроса.'
          this.deliveryBlocked = true; this.updateQuestion(question)
        }
        throw error
      }
    }
    this.emit(); this.pump()
  }
  private canConnect(): boolean { return (this.state.interview?.provider ?? this.state.settings.provider) === 'local' || this.state.hasToken }
  async ensureConnection(allowRecreate = false): Promise<void> {
    const interview = this.requireInterview()
    const epoch = this.connectionEpoch
    if (this.connectedInterview === interview.id && this.state.connection === 'ready') return
    await this.ai.connect(interview, {
      onConnection: (status, message) => {
        if (epoch !== this.connectionEpoch || this.state.interview?.id !== interview.id || this.shuttingDown) return
        this.state.connection = status; if (message) this.state.notice = message; this.emit()
      },
      onRemote: remote => {
        if (epoch !== this.connectionEpoch || this.state.interview?.id !== interview.id || this.shuttingDown) return
        // The adapter saves remote state together with its event cursor transaction.
        this.state.interview.remote = remote
      },
      onPartial: (questionId, answer, turnId) => {
        if (epoch !== this.connectionEpoch || this.shuttingDown || this.state.interview?.id !== interview.id) return
        const q = this.state.questions.find(q => q.id === questionId)
        if (!q || q.status === 'cancelled') return
        q.answer = answer; q.turnId = turnId ?? q.turnId
        const firstAnswer = this.markFirstAnswer(q)
        // The adapter has already persisted this answer. Do not repeat encrypted
        // writes and decrypt all interview history for every streaming snapshot.
        if (firstAnswer) this.store.saveQuestion(q)
        this.emit()
      }
    }, { allowRecreate })
    if (epoch === this.connectionEpoch && this.state.interview?.id === interview.id && !this.shuttingDown) this.connectedInterview = interview.id
  }
  async testConnection(): Promise<void> {
    if (this.state.aiReadiness.status === 'checking') return
    const settings = structuredClone(this.state.settings)
    this.state.aiReadiness = { ...this.state.aiReadiness, provider: settings.provider, status: 'checking' }; this.emit()
    try {
      const readiness = await this.ai.probe(settings)
      if (JSON.stringify(settings) === JSON.stringify(this.state.settings)) this.state.aiReadiness = readiness
    } catch (error) { this.state.aiReadiness = { provider: settings.provider, status: 'error', message: this.message(error) } }
    this.emit()
  }
  async recoverConnection(): Promise<void> {
    const interview = this.requireInterview()
    if (this.aiJob) throw new Error('Дождитесь завершения текущего запроса или отмените его.')
    if (interview.provider === 'local') { interview.localCodex.executablePath = this.state.settings.localCodex.executablePath; this.store.saveInterview(interview) }
    this.ai.disconnect(); this.connectedInterview = undefined; this.state.connection = 'disconnected'
    await this.ensureConnection(true)
    this.refreshRecoveredQuestions(); this.deliveryBlocked = !!this.state.interview?.remote.deliveryUncertain
    this.notify(this.deliveryBlocked ? 'Доставка не подтверждена. Очередь приостановлена: повторите прерванный вопрос вручную или начните новое интервью.' : 'Подключение восстановлено, ожидающие запросы сверены.'); this.pump()
  }
  private hasPending(question: Question): boolean {
    return this.store.listPending(question.interviewId).some(p => p.questionId === question.id && (p.command as { type?: string })?.type === 'turn.start')
  }
  private refreshRecoveredQuestions(): void {
    if (!this.state.interview) return
    this.state.questions = this.store.listQuestions(this.state.interview.id)
    for (const q of this.state.questions) {
      if (this.hasPending(q)) { q.status = 'queued'; this.store.saveQuestion(q) }
    }
    this.state.history = this.store.listInterviews(); this.emit()
  }
  private pump(): void {
    if (this.shuttingDown || this.suspending || !this.state.interview || this.state.interview.completed) return
    if (!this.sttJob) {
      const question = this.state.questions.find(q => q.status === 'transcribing' && this.audio.has(q.id))
      if (question) {
        const abort = new AbortController()
        const job = { questionId: question.id, abort, promise: Promise.resolve() }
        this.sttJob = job
        job.promise = this.runStt(question, abort.signal).finally(() => { this.sttJob = undefined; this.pump() })
      }
    }
    if (!this.aiJob && !this.deliveryBlocked && this.canConnect()) {
      const question = nextAiQuestion(this.state.questions)
      if (question) {
        const abort = new AbortController()
        const job = { questionId: question.id, abort, promise: Promise.resolve() }
        this.aiJob = job
        job.promise = this.runAi(question, abort.signal).finally(() => { if (this.aiJob === job) { this.aiJob = undefined; this.pump() } })
      }
    }
  }
  private async runStt(question: Question, signal: AbortSignal): Promise<void> {
    const captured = this.audio.get(question.id)!
    const startedAt = this.now()
    const segments = [] as Question['segments']
    let failed = false
    try {
      for (const track of captured.tracks) {
        if (signal.aborted) return
        segments.push(...await this.stt.transcribe(track, this.state.settings.language, signal))
      }
      if (signal.aborted || this.shuttingDown) return
      question.segments = segments.sort((a, b) => a.startMs - b.startMs)
      question.text = orderedTranscript(question.segments)
      question.durationMs = this.elapsed(startedAt)
      question.latency = { ...question.latency, sttMs: question.durationMs }
      question.status = question.text && !question.partial ? 'queued' : 'review'
      if (!question.text) question.error = 'Речь не обнаружена. Запишите вопрос еще раз или введите текст.'
      this.updateQuestion(question)
    } catch (error) {
      failed = true
      if (!signal.aborted && !this.shuttingDown) {
        question.segments = segments.sort((a, b) => a.startMs - b.startMs)
        question.text = orderedTranscript(question.segments)
        question.durationMs = this.elapsed(startedAt)
        question.latency = { ...question.latency, sttMs: question.durationMs }
        question.partial = true; question.status = 'review'; question.error = this.message(error)
        this.updateQuestion(question)
      }
    } finally {
      this.diagnostics({ operation: 'stt', result: signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed', durationMs: this.elapsed(startedAt), questionId: question.id })
      this.audio.delete(question.id)
    }
  }
  private async runAi(question: Question, signal: AbortSignal): Promise<void> {
    const startedAt = this.now()
    const hadPending = this.hasPending(question)
    const timing = this.timings.get(question.id)
    if (timing && !hadPending) question.latency = { ...question.latency, queueMs: Math.max(0, Math.round(startedAt - timing.inputReadyAt - (question.latency?.sttMs ?? 0))) }
    question.status = 'generating'; this.updateQuestion(question)
    try {
      const connectionStartedAt = this.now()
      await this.ensureConnection()
      if (signal.aborted || this.shuttingDown) return
      if (timing && !hadPending) {
        question.latency = { ...question.latency, connectionMs: this.elapsed(connectionStartedAt) }
        timing.requestSentAt = this.now()
      }
      const recovered = this.store.listQuestions(question.interviewId).find(q => q.id === question.id)
      if (hadPending && recovered && !this.hasPending(question) && ['completed', 'failed', 'cancelled', 'interrupted'].includes(recovered.status)) {
        this.updateQuestion(recovered); return
      }
      const interview = this.requireInterview()
      const answer = await this.ai.send(question, buildPrompt(interview, question, this.state.questions), signal)
      if (signal.aborted || this.shuttingDown) return
      question.answer = answer.text; question.turnId = answer.turnId; question.status = 'completed'; question.error = undefined
      this.markFirstAnswer(question)
      if (timing && !hadPending && timing.requestSentAt !== undefined) question.latency = { ...question.latency, aiTotalMs: this.elapsed(timing.requestSentAt), totalMs: this.elapsed(timing.inputReadyAt) }
      this.updateQuestion(question)
    } catch (error) {
      if (!signal.aborted && !this.shuttingDown) {
        this.deliveryBlocked = this.hasPending(question)
        question.status = this.deliveryBlocked ? 'queued' : 'failed'; question.error = this.message(error)
        if (this.deliveryBlocked) this.state.notice = 'Результат запроса уточняется. Нажмите «Продолжить подключение» в настройках; очередь приостановлена.'
        this.updateQuestion(question)
      }
    } finally {
      this.diagnostics({ operation: 'ai', result: signal.aborted ? 'cancelled' : question.status === 'completed' ? 'completed' : 'failed', durationMs: this.elapsed(startedAt), questionId: question.id, latency: question.latency,
        provider: this.state.interview?.provider, model: this.state.interview?.provider === 'local' ? this.state.interview.localCodex.model : undefined, cliVersion: this.state.interview?.remote.cliVersion })
      this.timings.delete(question.id)
    }
  }
  private elapsed(startedAt: number): number { return Math.max(0, Math.round(this.now() - startedAt)) }
  private markFirstAnswer(question: Question): boolean {
    const timing = this.timings.get(question.id)
    if (!question.answer.trim() || question.latency?.firstAnswerMs !== undefined || timing?.requestSentAt === undefined) return false
    question.latency = { ...question.latency, aiFirstAnswerMs: this.elapsed(timing.requestSentAt), firstAnswerMs: this.elapsed(timing.inputReadyAt) }
    return true
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'Неизвестная ошибка обработки.' }
  async shutdown(): Promise<void> {
    this.shuttingDown = true; clearTimeout(this.recordingTimer)
    this.sttJob?.abort.abort()
    // Disconnect deliberately leaves an accepted server turn resumable after restart.
    this.ai.disconnect()
    await Promise.allSettled([this.ai.dispose?.(), this.capture.dispose(), this.stt.dispose(), this.sttJob?.promise, this.aiJob?.promise])
    this.audio.clear()
    this.timings.clear()
  }
}
