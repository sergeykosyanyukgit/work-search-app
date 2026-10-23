import { MAX_OUTSTANDING, TERMINAL_STATUSES, type Question } from './types'

export function outstandingCount(questions: Question[]): number {
  return questions.filter(q => !TERMINAL_STATUSES.includes(q.status)).length
}
export function assertQueueCapacity(questions: Question[]): void {
  if (outstandingCount(questions) >= MAX_OUTSTANDING) throw new Error('Очередь заполнена: дождитесь ответа или отмените один из трех вопросов.')
}
/** A later completed transcription must never overtake an earlier recording. */
export function nextAiQuestion(questions: Question[]): Question | undefined {
  const head = questions.filter(q => !TERMINAL_STATUSES.includes(q.status)).sort((a, b) => a.order - b.order)[0]
  return head?.status === 'queued' ? head : undefined
}
export function orderedTranscript(segments: Question['segments']): string {
  return [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map(s => `[${s.source === 'system' ? 'Системный звук' : 'Микрофон'}] ${s.text.trim()}`).filter(s => !s.endsWith('] ')).join('\n')
}
