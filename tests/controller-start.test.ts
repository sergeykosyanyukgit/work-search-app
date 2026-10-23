import { describe, expect, it, vi } from 'vitest'
import { InterviewController } from '../src/application/interview-controller'
import { DEFAULT_SETTINGS, type DiagnosticEvent, type Interview, type PendingCommand, type Question } from '../src/domain/types'
import type { AiSessionCallbacks, AiSessionPort, AudioCapturePort, InterviewRepository, SecretStore, SettingsRepository, SttPort } from '../src/domain/ports'

function fixture() {
  const interviews = new Map<string, Interview>()
  const questions = new Map<string, Question>()
  const pending = new Map<string, PendingCommand>()
  const store: InterviewRepository & SettingsRepository & SecretStore = {
    getSettings: () => structuredClone(DEFAULT_SETTINGS), saveSettings: () => {},
    getToken: () => 'test-only-token', setToken: () => {}, clearToken: () => {},
    getInterview: id => { const row = interviews.get(id); return row && structuredClone(row) },
    saveInterview: row => { interviews.set(row.id, structuredClone(row)) }, deleteInterview: id => { interviews.delete(id) },
    listInterviews: () => [...interviews.values()].map(row => ({ ...row, questionCount: [...questions.values()].filter(q => q.interviewId === row.id).length })),
    listQuestions: id => [...questions.values()].filter(q => q.interviewId === id).map(q => structuredClone(q)),
    saveQuestion: row => { questions.set(row.id, structuredClone(row)) },
    listPending: id => [...pending.values()].filter(p => p.interviewId === id).map(p => structuredClone(p)),
    savePending: row => { pending.set(row.id, structuredClone(row)) }, deletePending: id => { pending.delete(id) },
    transaction: action => action()
  }
  const capture: AudioCapturePort = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => ({ recordingId: 'unused', tracks: [], partial: false })),
    cancel: vi.fn(async () => {}), onLevels: () => {}, onStopped: () => {}, dispose: async () => {}
  }
  const stt: SttPort = { getState: () => ({ status: 'ready' }), onState: () => {}, prepare: async () => {},
    transcribe: async () => [], downloadModel: async () => {}, importModel: async () => {}, dispose: async () => {} }
  const ai: AiSessionPort = { probe: async settings => ({ provider: settings.provider, status: 'ready', message: 'Проверено' }), connect: vi.fn(async (_interview, callbacks) => callbacks.onConnection('ready')),
    send: vi.fn(async () => ({ text: 'Проверенный ответ', turnId: 'test-turn' })), disconnect: vi.fn(), cancel: async () => {}, close: async () => {} }
  return { store, capture, stt, ai, make: (now?: () => number) => new InterviewController(store, capture, stt, ai, now) }
}

describe('explicit first question', () => {
  it('creates an interview and sends a manual question without a separate hidden setup action', async () => {
    const { make, ai, capture } = fixture()
    const controller = make()
    expect(controller.snapshot().interview).toBeUndefined()
    expect(ai.connect).not.toHaveBeenCalled()
    expect(capture.start).not.toHaveBeenCalled()
    await controller.submitText('Как устроена очередь событий?')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    expect(controller.snapshot().interview?.completed).toBe(false)
    expect(controller.snapshot().questions[0]?.answer).toBe('Проверенный ответ')
    expect(ai.send).toHaveBeenCalledTimes(1)
    await controller.shutdown()
  })

  it('creates a fresh interview on the first recording action without resuming saved history', async () => {
    const { make, store, capture } = fixture()
    const previous = make()
    await previous.newInterview('Сохраненное интервью')
    const previousId = previous.snapshot().interview!.id
    await previous.shutdown()
    const controller = make()
    expect(controller.snapshot().interview).toBeUndefined()
    await controller.toggleRecording()
    expect(controller.snapshot().interview?.id).not.toBe(previousId)
    expect(controller.snapshot().capture).toBe('recording')
    expect(capture.start).toHaveBeenCalledTimes(1)
    expect(store.getInterview(previousId)?.title).toBe('Сохраненное интервью')
    expect(store.listInterviews()).toHaveLength(2)
    await controller.cancel(controller.snapshot().questions[0]!.id)
    await controller.shutdown()
  })

  it('creates a new interview after finishing the previous one, keeping its answer', async () => {
    const { make, store } = fixture()
    const controller = make()
    await controller.submitText('Первый вопрос')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    const firstId = controller.snapshot().interview!.id
    await controller.finishInterview()
    await controller.submitText('Новый вопрос')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    expect(controller.snapshot().interview!.id).not.toBe(firstId)
    expect(store.getInterview(firstId)?.completed).toBe(true)
    expect(store.listQuestions(firstId)[0]?.answer).toBe('Проверенный ответ')
    await controller.shutdown()
  })

  it('rejects missing speech setup and empty text before creating an interview', async () => {
    const { make, store, stt, capture } = fixture()
    stt.getState = () => ({ status: 'missing' })
    const controller = make()
    await expect(controller.toggleRecording()).rejects.toThrow('Подготовьте модель Whisper')
    await expect(controller.submitText('   ')).rejects.toThrow('Введите текст вопроса')
    expect(store.listInterviews()).toHaveLength(0)
    expect(capture.start).not.toHaveBeenCalled()
    await controller.shutdown()
  })

  it('does not move a revision into an automatically created interview', async () => {
    const { make, store } = fixture()
    const controller = make()
    await expect(controller.submitText('Исправленный вопрос', 'old-question')).rejects.toThrow('Начните новое интервью')
    expect(store.listInterviews()).toHaveLength(0)
    await controller.shutdown()
  })
})

describe('response latency', () => {
  it('measures the first visible answer separately from completion without repeated history reads', async () => {
    const { make, ai, store } = fixture()
    let time = 100
    let callbacks!: AiSessionCallbacks
    const listHistory = vi.spyOn(store, 'listInterviews')
    const writeInterview = vi.spyOn(store, 'saveInterview')
    ai.connect = vi.fn(async (_interview, cb) => { callbacks = cb; time = 230; cb.onConnection('ready') })
    ai.send = vi.fn(async question => {
      listHistory.mockClear(); writeInterview.mockClear()
      time = 300; callbacks.onPartial(question.id, '', 'turn')
      expect(question.latency?.firstAnswerMs).toBeUndefined()
      time = 1600; callbacks.onPartial(question.id, 'Первый текст', 'turn')
      time = 1900; callbacks.onPartial(question.id, 'Обновленный текст', 'turn')
      expect(listHistory).not.toHaveBeenCalled()
      expect(writeInterview).not.toHaveBeenCalled()
      time = 2300
      return { text: 'Полный ответ', turnId: 'turn' }
    })
    const controller = make(() => time)
    const diagnosticEvents: DiagnosticEvent[] = []
    controller.onDiagnostics(event => diagnosticEvents.push(event))
    await controller.submitText('Вопрос')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    const question = controller.snapshot().questions[0]!
    expect(question.latency).toEqual({ queueMs: 0, connectionMs: 130, aiFirstAnswerMs: 1370, aiTotalMs: 2070, firstAnswerMs: 1500, totalMs: 2200 })
    expect(store.listQuestions(question.interviewId)[0]?.latency).toEqual(question.latency)
    expect(diagnosticEvents.find(event => event.operation === 'ai')?.latency).toEqual(question.latency)
    await controller.shutdown()
  })

  it('opens AI while recording and measures from stop, excluding the recording itself', async () => {
    const { make, capture, stt, ai } = fixture()
    let time = 100
    let callbacks!: AiSessionCallbacks
    ai.connect = vi.fn(async (_interview, cb) => { callbacks = cb; cb.onConnection('ready') })
    stt.transcribe = vi.fn<SttPort['transcribe']>(async () => { time = 1600; return [{ source: 'microphone', startMs: 0, endMs: 1000, text: 'Вопрос' }] })
    ai.send = vi.fn(async question => {
      time = 2000; callbacks.onPartial(question.id, 'Первый текст', 'turn')
      time = 2200; return { text: 'Ответ', turnId: 'turn' }
    })
    const controller = make(() => time)
    await controller.toggleRecording()
    await vi.waitFor(() => expect(ai.connect).toHaveBeenCalledTimes(1))
    expect(ai.send).not.toHaveBeenCalled()
    expect(controller.snapshot().capture).toBe('recording')
    const recordingId = controller.snapshot().questions[0]!.id
    capture.stop = vi.fn<AudioCapturePort['stop']>(async () => ({ recordingId, partial: false, tracks: [{ source: 'microphone', pcm: new Uint8Array(32000), sampleRate: 16000, offsetMs: 0 }] }))
    time = 1100
    await controller.toggleRecording()
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    expect(ai.connect).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().questions[0]?.latency).toEqual({ sttMs: 500, queueMs: 0, connectionMs: 0, aiFirstAnswerMs: 400, aiTotalMs: 600, firstAnswerMs: 900, totalMs: 1100 })
    await controller.shutdown()
  })
})

describe('explicit connection check', () => {
  it('runs local questions without a manager token and freezes provider/model for the interview', async () => {
    const { make, ai, store } = fixture()
    store.getToken = () => undefined
    const controller = make()
    controller.saveSettings({ ...structuredClone(DEFAULT_SETTINGS), provider: 'local' })
    await controller.submitText('Local question')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    expect(controller.snapshot().interview?.provider).toBe('local')
    controller.saveSettings({ ...structuredClone(DEFAULT_SETTINGS), provider: 'cloud', localCodex: { executablePath: 'C:\\New Codex\\codex.exe', model: 'different' } })
    await controller.submitText('Same local interview')
    await vi.waitFor(() => expect(controller.snapshot().questions[1]?.status).toBe('completed'))
    expect(controller.snapshot().interview?.localCodex.model).toBe('gpt-5.6-sol')
    expect(ai.send).toHaveBeenCalledTimes(2)
    await controller.recoverConnection()
    expect(controller.snapshot().interview?.localCodex).toEqual({ executablePath: 'C:\\New Codex\\codex.exe', model: 'gpt-5.6-sol' })
    await controller.newInterview()
    expect(controller.snapshot().interview?.provider).toBe('cloud')
    await controller.shutdown()
  })
  it('does not disconnect a local generation when cloud credentials change', async () => {
    const { make, ai } = fixture()
    let complete!: (value: { text: string; turnId: string }) => void
    ai.send = vi.fn(() => new Promise<{ text: string; turnId: string }>(resolve => { complete = resolve }))
    const controller = make()
    controller.saveSettings({ ...structuredClone(DEFAULT_SETTINGS), provider: 'local' })
    await controller.submitText('Local question')
    await vi.waitFor(() => expect(ai.send).toHaveBeenCalled())
    const before = vi.mocked(ai.disconnect).mock.calls.length
    controller.saveSettings(controller.snapshot().settings, 'new-cloud-token')
    controller.clearToken()
    await controller.testConnection()
    expect(ai.disconnect).toHaveBeenCalledTimes(before)
    complete({ text: 'Local answer', turnId: 'local-turn' })
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    await controller.shutdown()
  })
  it('checks saved configuration without creating an interview or connecting the active adapter', async () => {
    const { make, ai } = fixture()
    const controller = make()
    await controller.testConnection()
    const disconnects = vi.mocked(ai.disconnect).mock.calls.length
    await controller.testConnection()
    expect(ai.connect).not.toHaveBeenCalled()
    expect(ai.disconnect).toHaveBeenCalledTimes(disconnects)
    expect(controller.snapshot().aiReadiness.status).toBe('ready'); expect(controller.snapshot().interview).toBeUndefined()
    await controller.shutdown()
  })

  it('does not disconnect an active AI request during a connection check', async () => {
    const { make, ai } = fixture()
    let complete!: (answer: { text: string; turnId: string }) => void
    ai.send = vi.fn(() => new Promise<{ text: string; turnId: string }>(resolve => { complete = resolve }))
    const controller = make()
    await controller.submitText('Вопрос в обработке')
    await vi.waitFor(() => expect(ai.send).toHaveBeenCalledTimes(1))
    const disconnects = vi.mocked(ai.disconnect).mock.calls.length
    await controller.testConnection()
    expect(ai.disconnect).toHaveBeenCalledTimes(disconnects)
    complete({ text: 'Ответ', turnId: 'turn' })
    await vi.waitFor(() => expect(controller.snapshot().questions[0]?.status).toBe('completed'))
    await controller.shutdown()
  })
})
