import { describe, expect, it, vi } from 'vitest'
import { InterviewController } from '../src/application/interview-controller'
import { DEFAULT_SETTINGS, type Interview, type PendingCommand, type Question } from '../src/domain/types'
import type { AiSessionPort, AudioCapturePort, InterviewRepository, SettingsRepository, SecretStore, SttPort } from '../src/domain/ports'

function fixture(status: Question['status'] = 'generating') {
  const interview: Interview = { provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex), id: 'interview', title: 'Saved interview', createdAt: 0, updatedAt: 0, profile: structuredClone(DEFAULT_SETTINGS.profile), serviceUrl: 'https://fixture.invalid', profileSlug: 'interview-assistant', remote: { sessionId: 'remote', openRequestId: 'open', lastSequence: 3, contextSent: true }, completed: false }
  let questions: Question[] = [{ id: 'question', interviewId: interview.id, createdAt: 0, order: 1, status, segments: [], text: 'Question', answer: '', partial: false }]
  const pending: PendingCommand[] = [{ id: 'request', interviewId: interview.id, questionId: 'question', sessionId: 'remote', command: { v: 1, type: 'turn.start', clientRequestId: 'request', payload: { inputs: [{ type: 'text', text: 'original prompt' }], originator: 'chatgpt' } }, createdAt: 0 }]
  const store: InterviewRepository & SettingsRepository & SecretStore = {
    getInterview: () => structuredClone(interview), saveInterview: row => Object.assign(interview, structuredClone(row)), listInterviews: () => [], deleteInterview: () => undefined,
    listQuestions: () => structuredClone(questions), saveQuestion: row => { const index = questions.findIndex(item => item.id === row.id); if (index < 0) questions.push(structuredClone(row)); else questions[index] = structuredClone(row) },
    listPending: () => structuredClone(pending), savePending: row => { pending.push(row) }, deletePending: id => { const index = pending.findIndex(row => row.id === id); if (index >= 0) pending.splice(index, 1) }, transaction: action => action(),
    getSettings: () => structuredClone(DEFAULT_SETTINGS), saveSettings: () => undefined, getToken: () => 'test-only-token', setToken: () => undefined, clearToken: () => undefined
  }
  const capture = { onLevels: () => undefined, onStopped: () => undefined, dispose: async () => undefined } as unknown as AudioCapturePort
  const stt = { getState: () => ({ status: 'ready' }), onState: () => undefined, dispose: async () => undefined } as unknown as SttPort
  const ai: AiSessionPort = { probe: async settings => ({ provider: settings.provider, status: 'ready', message: 'Проверено' }), connect: async (_interview, callbacks) => callbacks.onConnection('ready'), send: vi.fn(async () => ({ text: 'Answer', turnId: 'turn' })), cancel: async () => undefined, close: async () => undefined, disconnect: () => undefined }
  return { interview, store, capture, stt, ai, makeController: () => new InterviewController(store, capture, stt, ai) }
}

describe('controller recovery integration', () => {
  it('does not enqueue a turn that became completed during AI session restoration', async () => {
    const { store, ai, makeController } = fixture()
    ai.connect = async (_interview, callbacks) => {
      store.saveQuestion({ ...store.listQuestions('interview')[0]!, status: 'completed', answer: 'Recovered authoritative answer', turnId: 'turn' })
      store.deletePending('request')
      callbacks.onConnection('ready')
    }
    const controller = makeController()
    await controller.resumeInterview('interview')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]!.status).toBe('completed'))
    expect(controller.snapshot().questions[0]!.answer).toBe('Recovered authoritative answer')
    expect(ai.send).not.toHaveBeenCalled()
    await controller.shutdown()
  })

  it('resumes a failed local question with an unresolved durable command', async () => {
    const { ai, makeController } = fixture('failed')
    const controller = makeController()
    await controller.resumeInterview('interview')
    await vi.waitFor(() => expect(ai.send).toHaveBeenCalledTimes(1))
    expect(controller.snapshot().questions[0]!.status).toBe('completed')
    await controller.shutdown()
  })

  it('holds later queued questions when delivery is uncertain and does not pretend cancellation succeeded', async () => {
    const { store, ai, makeController } = fixture('failed')
    ai.send = vi.fn(async () => { throw new Error('Connection lost after send') })
    const controller = makeController()
    await controller.resumeInterview('interview')
    await vi.waitFor(() => expect(controller.snapshot().questions[0]!.error).toContain('Connection lost'))
    expect(controller.snapshot().questions[0]!.status).toBe('queued')
    await controller.submitText('The next question')
    await expect(controller.cancel('question')).rejects.toThrow('восстановите соединение')
    expect(controller.snapshot().questions[0]!.status).toBe('queued')
    expect(ai.send).toHaveBeenCalledTimes(1)
    expect(store.listPending('interview')).toHaveLength(1)
    await controller.shutdown()
  })
})
