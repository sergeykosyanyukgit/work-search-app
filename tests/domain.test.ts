import { describe, expect, it } from 'vitest'
import { assertQueueCapacity, nextAiQuestion, orderedTranscript } from '../src/domain/queue'
import { buildPrompt } from '../src/domain/prompt'
import { DEFAULT_SETTINGS, type Interview, type Question } from '../src/domain/types'
import { SettingsSchema } from '../src/shared/ipc'

const q = (order: number, status: Question['status']): Question => ({ id: `${order}`, interviewId: 'interview', order, status, createdAt: 0, text: `Question ${order}`, answer: `Answer ${order}`, segments: [], partial: false })
const interview = (): Interview => ({ provider: 'cloud', localCodex: structuredClone(DEFAULT_SETTINGS.localCodex), id: 'interview', title: 'Test', createdAt: 0, updatedAt: 0, profile: { ...DEFAULT_SETTINGS.profile, resume: 'candidate context' }, serviceUrl: DEFAULT_SETTINGS.serviceUrl, profileSlug: 'interview-assistant', remote: { openRequestId: 'open', lastSequence: 0, contextSent: false }, completed: false })
describe('FIFO and prompt boundaries', () => {
  it('reserves three slots including recordings and blocks overtaking', () => {
    const queue = [q(1, 'transcribing'), q(2, 'queued'), q(3, 'recording')]
    expect(() => assertQueueCapacity(queue)).toThrow('Очередь заполнена')
    expect(nextAiQuestion(queue)).toBeUndefined()
    queue[0]!.status = 'completed'
    expect(nextAiQuestion(queue)?.id).toBe('2')
    expect(() => assertQueueCapacity(queue)).not.toThrow()
  })
  it('skips review/failed questions without deleting history', () => {
    expect(nextAiQuestion([q(1, 'review'), q(2, 'failed'), q(3, 'queued')])?.id).toBe('3')
  })
  it('orders independent sources on the shared timeline', () => {
    expect(orderedTranscript([{ source: 'microphone', startMs: 1000, endMs: 2000, text: 'уточнение' }, { source: 'system', startMs: 0, endMs: 1000, text: 'вопрос' }]))
      .toBe('[Системный звук] вопрос\n[Микрофон] уточнение')
  })
  it('restores at most twenty completed pairs and omits profile on established session', () => {
    const i = interview(); const history = Array.from({ length: 30 }, (_, n) => q(n + 1, 'completed'))
    const prompt = buildPrompt(i, q(31, 'queued'), history)
    expect(prompt).toContain('Question 11\n'); expect(prompt).not.toContain('Question 10\n'); expect(prompt).toContain('candidate context')
    i.remote.contextSent = true
    expect(buildPrompt(i, q(31, 'queued'), history)).not.toContain('candidate context')
    expect(buildPrompt(i, q(31, 'queued'), history)).not.toContain('<previous_interview_context>')
  })
  it('rejects insecure remote endpoints and embedded credentials', () => {
    for (const serviceUrl of ['http://example.com', 'https://secret@example.com', 'https://example.com?token=secret']) expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, serviceUrl }).success).toBe(false)
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, serviceUrl: 'http://127.0.0.1:5000' }).success).toBe(true)
  })
})
