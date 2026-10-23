import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapturedTrack } from '../src/domain/types'
import { WhisperCppAdapter } from '../src/adapters/stt/whisper-cpp'
import { parseWhisperResponse } from '../src/adapters/stt/whisper-response'

const track: CapturedTrack = { source: 'system', sampleRate: 16000, offsetMs: 120, pcm: new Uint8Array(16000 * 2 * 2) }
const temporary: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('Whisper integration boundary', () => {
  it('retains source and adds capture offsets to speech timestamps', () => {
    expect(parseWhisperResponse({ text: 'Вопрос', segments: [{ text: ' Вопрос ', start: 0.1, end: 1.8 }] }, track)).toEqual([{ source: 'system', text: 'Вопрос', startMs: 220, endMs: 1920 }])
  })

  it('clips rounded decoder timestamps to actual audio and drops silence markers', () => {
    expect(parseWhisperResponse({ text: '', segments: [{ text: '[BLANK_AUDIO]', start: 0, end: 1 }, { text: 'Пример', start: 1.9, end: 2.4 }] }, track)).toEqual([{ source: 'system', text: 'Пример', startMs: 2020, endMs: 2120 }])
  })

  it('rejects malformed and unordered segment times instead of fabricating timestamps', () => {
    expect(() => parseWhisperResponse({ text: 'text' }, track)).toThrow(/метки/)
    expect(() => parseWhisperResponse({ text: 'text', segments: [{ text: 'text', start: 3, end: 2 }] }, track)).toThrow(/метки/)
    expect(() => parseWhisperResponse({ text: 'text', segments: [{ text: 'text', start: Number.NaN, end: 2 }] }, track)).toThrow(/метки/)
  })

  it('skips digital silence without starting or requiring a native engine', async () => {
    const adapter = new WhisperCppAdapter({ binaryDirectory: 'missing-test-engine', modelDirectory: 'missing-test-model' })
    expect(await adapter.transcribe(track, 'ru', new AbortController().signal)).toEqual([])
    await adapter.dispose()
  })

  it('honors cancellation before any resource or network work', async () => {
    const adapter = new WhisperCppAdapter({ binaryDirectory: 'missing-test-engine', modelDirectory: 'missing-test-model' })
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(adapter.transcribe(track, 'ru', controller.signal)).rejects.toThrow('cancelled')
    await adapter.dispose()
  })

  it('refuses an arbitrary imported file and leaves no installed model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interview-stt-test-')); temporary.push(directory)
    const source = join(directory, 'untrusted.bin'); await writeFile(source, 'not a whisper model')
    const adapter = new WhisperCppAdapter({ binaryDirectory: directory, modelDirectory: join(directory, 'models') })
    await expect(adapter.importModel(source)).rejects.toThrow(/ggml-small/)
    expect(adapter.getState().status).toBe('error')
    await adapter.dispose()
  })

  it('rejects an incomplete download and deletes its temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interview-stt-download-')); temporary.push(directory)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    const modelDirectory = join(directory, 'models')
    const adapter = new WhisperCppAdapter({ binaryDirectory: directory, modelDirectory })
    await expect(adapter.downloadModel()).rejects.toThrow(/Контрольная сумма/)
    expect(await readdir(modelDirectory)).toEqual([])
    await adapter.dispose()
  })
})
