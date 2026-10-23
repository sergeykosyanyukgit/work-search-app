import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { DiagnosticEvent, QuestionLatency } from '../../domain/types'
export type { DiagnosticEvent } from '../../domain/types'
const latencyKeys = ['sttMs', 'queueMs', 'connectionMs', 'aiFirstAnswerMs', 'aiTotalMs', 'firstAnswerMs', 'totalMs'] as const
function safeLatency(value?: QuestionLatency): QuestionLatency | undefined {
  if (!value) return undefined
  return Object.fromEntries(latencyKeys.flatMap(key => {
    const duration = value[key]
    return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? [[key, Math.round(duration)]] : []
  }))
}
/** Deliberately accepts no text, URL, token, prompt, or exception fields. */
export class Diagnostics {
  constructor(private readonly path: string) {}
  write(event: DiagnosticEvent): void {
    try {
      if (existsSync(this.path) && statSync(this.path).size > 1_048_576) {
        if (existsSync(`${this.path}.1`)) unlinkSync(`${this.path}.1`)
        renameSync(this.path, `${this.path}.1`)
      }
      const safeIdentifier = (value?: string) => value && /^[a-zA-Z0-9.+_-]{1,150}$/.test(value) ? value : undefined
      appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), operation: event.operation, code: `${event.operation.toUpperCase()}_${event.result.toUpperCase()}`, durationMs: Math.round(event.durationMs), questionId: event.questionId, latency: safeLatency(event.latency), provider: ['cloud', 'local'].includes(event.provider ?? '') ? event.provider : undefined, model: safeIdentifier(event.model), cliVersion: safeIdentifier(event.cliVersion) })}\n`, 'utf8')
    } catch { /* Diagnostics must not break an interview. */ }
  }
}
