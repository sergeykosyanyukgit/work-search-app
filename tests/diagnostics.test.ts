import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Diagnostics } from '../src/adapters/storage/diagnostics'
import type { DiagnosticEvent } from '../src/domain/types'

it('logs only bounded numeric latency fields and excludes unexpected sensitive payloads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-search-diagnostics-'))
  try {
    const path = join(directory, 'diagnostics.log')
    new Diagnostics(path).write({
      operation: 'ai', result: 'completed', durationMs: 2200, questionId: 'opaque-id',
      latency: { firstAnswerMs: 1400.3, aiTotalMs: 1900, totalMs: 2200, queueMs: -1, connectionMs: Infinity, token: 'PRIVATE_TOKEN', text: 'PRIVATE_QUESTION' },
      prompt: 'PRIVATE_PROMPT'
    } as unknown as DiagnosticEvent)
    const raw = readFileSync(path, 'utf8')
    expect(JSON.parse(raw).latency).toEqual({ firstAnswerMs: 1400, aiTotalMs: 1900, totalMs: 2200 })
    expect(raw).not.toContain('PRIVATE_')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
