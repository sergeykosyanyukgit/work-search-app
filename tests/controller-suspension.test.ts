import { describe, expect, it, vi } from 'vitest'
import { InterviewController } from '../src/application/interview-controller'
import type { AiSessionCallbacks, AiSessionPort, AudioCapturePort, SttPort } from '../src/domain/ports'
import type { CaptureResult } from '../src/domain/types'
import { MemoryStore } from './helpers/memory-store'

function fixture() {
  const store = new MemoryStore()
  store.setToken('fixture-token')
  let stopped!: (result: CaptureResult) => void
  const capture: AudioCapturePort = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => ({ recordingId: '', tracks: [], partial: false })),
    cancel: vi.fn(async () => {}), onLevels: () => {}, onStopped: cb => { stopped = cb }, dispose: async () => {}
  }
  const stt: SttPort = { getState: () => ({ status: 'ready' }), onState: () => {}, prepare: async () => {},
    transcribe: vi.fn(async () => []), downloadModel: async () => {}, importModel: async () => {}, dispose: async () => {} }
  const ai: AiSessionPort = { probe: async settings => ({ provider: settings.provider, status: 'ready' }),
    connect: vi.fn(async (_interview, cb) => cb.onConnection('ready')),
    send: vi.fn(async () => ({ text: 'Ответ', turnId: 'turn' })), cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}), disconnect: vi.fn() }
  return { store, capture, stt, ai, stopped: (result: CaptureResult) => stopped(result), controller: new InterviewController(store, capture, stt, ai) }
}

describe('partial speech review', () => {
  it.each([false, true])('retains successful speech when a later track fails (partial capture: %s)', async partial => {
    const f = fixture()
    f.stt.transcribe = vi.fn<SttPort['transcribe']>().mockResolvedValueOnce([{ source: 'microphone', startMs: 0, endMs: 100, text: 'Сохранённый вопрос' }]).mockRejectedValueOnce(new Error('Ошибка второй дорожки'))
    await f.controller.toggleRecording()
    const id = f.controller.snapshot().questions[0]!.id
    f.stopped({ recordingId: id, partial, tracks: ['microphone', 'system'].map(source => ({ source: source as 'microphone' | 'system', pcm: new Uint8Array(3200), sampleRate: 16000, offsetMs: 0 })) })
    await vi.waitFor(() => expect(f.controller.snapshot().questions[0]?.status).toBe('review'))
    expect(f.store.listQuestions(f.controller.snapshot().interview!.id)[0]).toMatchObject({ partial: true, error: 'Ошибка второй дорожки', segments: [{ text: 'Сохранённый вопрос' }] })
    expect(f.controller.snapshot().questions[0]?.text).toContain('Сохранённый вопрос')
    expect(f.ai.send).not.toHaveBeenCalled()
    await f.controller.shutdown()
  })
})

describe('local interview suspension', () => {
  it('finishes locally even when a ready connection rejects close', async () => {
    const f = fixture()
    await f.controller.newInterview()
    await f.controller.ensureConnection()
    f.ai.close = vi.fn(async () => { throw new Error('Cloud close failed') })
    await f.controller.finishInterview()
    expect(f.controller.snapshot().interview?.completed).toBe(true)
    expect(f.ai.close).toHaveBeenCalledTimes(1)
    expect(f.ai.disconnect).toHaveBeenCalled()
    await f.controller.shutdown()
  })
  it.each(['finish', 'new'] as const)('can %s an offline interview without closing or reconnecting', async operation => {
    const f = fixture()
    f.ai.connect = vi.fn(async (_interview, cb) => cb.onConnection('recovering'))
    f.ai.close = vi.fn(async () => { throw new Error('Cloud unavailable') })
    await f.controller.newInterview()
    const id = f.controller.snapshot().interview!.id
    await f.controller.ensureConnection()
    if (operation === 'finish') await f.controller.finishInterview()
    else await f.controller.newInterview()
    expect(f.ai.close).not.toHaveBeenCalled()
    expect(f.ai.connect).toHaveBeenCalledTimes(1)
    expect(f.ai.disconnect).toHaveBeenCalled()
    expect(operation === 'finish' ? f.store.getInterview(id)?.completed : f.controller.snapshot().interview?.id !== id).toBe(true)
    await f.controller.shutdown()
  })

  it('preserves an active durable request and ignores late callbacks while a new interview runs', async () => {
    const f = fixture()
    let oldCallbacks!: AiSessionCallbacks
    let resolveOld!: (answer: { text: string; turnId: string }) => void
    let resolveNew!: (answer: { text: string; turnId: string }) => void
    f.ai.connect = vi.fn(async (_interview, cb) => { oldCallbacks ??= cb; cb.onConnection('ready') })
    f.ai.send = vi.fn<AiSessionPort['send']>().mockImplementationOnce(question => {
      f.store.savePending({ id: 'durable', interviewId: question.interviewId, questionId: question.id, createdAt: 0, command: { type: 'turn.start' } })
      return new Promise(resolve => { resolveOld = resolve })
    }).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
    await f.controller.submitText('Первый')
    await vi.waitFor(() => expect(f.ai.send).toHaveBeenCalledTimes(1))
    const previous = f.controller.snapshot()
    await f.controller.newInterview()
    expect(f.store.listPending(previous.interview!.id)).toHaveLength(1)
    expect(f.store.listQuestions(previous.interview!.id)[0]?.status).not.toBe('cancelled')
    expect(f.ai.cancel).not.toHaveBeenCalled()
    expect(f.ai.close).not.toHaveBeenCalled()
    await f.controller.submitText('Новый')
    await vi.waitFor(() => expect(f.ai.send).toHaveBeenCalledTimes(2))
    resolveOld({ text: 'Поздний ответ', turnId: 'old' })
    oldCallbacks.onConnection('error', 'Старое соединение')
    await f.controller.submitText('Следующий')
    await Promise.resolve()
    expect(f.ai.send).toHaveBeenCalledTimes(2)
    expect(f.controller.snapshot().connection).toBe('ready')
    expect(f.controller.snapshot().questions[0]?.answer).toBe('')
    resolveNew({ text: 'Новый ответ', turnId: 'new' })
    await vi.waitFor(() => expect(f.ai.send).toHaveBeenCalledTimes(3))
    await f.controller.shutdown()
  })
})
