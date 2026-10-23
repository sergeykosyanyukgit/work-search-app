import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { CapturedTrack, SttState } from '../src/domain/types'
import { WhisperCppAdapter } from '../src/adapters/stt/whisper-cpp'

const binaryDirectory = process.env.WHISPER_TEST_BINARY_DIRECTORY
const modelDirectory = process.env.WHISPER_TEST_MODEL_DIRECTORY

async function fixtureTrack(name: string, source: CapturedTrack['source'] = 'system'): Promise<CapturedTrack> {
  const wav = await readFile(fileURLToPath(new URL(`./audio-fixtures/${name}.wav`, import.meta.url)))
  let data: Buffer | undefined
  for (let position = 12; position + 8 <= wav.byteLength;) {
    const length = wav.readUInt32LE(position + 4)
    if (wav.toString('ascii', position, position + 4) === 'data') { data = wav.subarray(position + 8, position + 8 + length); break }
    position += 8 + length + (length % 2)
  }
  expect(data).toBeDefined()
  return { source, pcm: data!, sampleRate: 16000, offsetMs: 250 }
}

it.runIf(Boolean(binaryDirectory && modelDirectory))('loads the pinned CPU engine, transcribes a synthetic fixture, and recovers after cancellation', async () => {
  const adapter = new WhisperCppAdapter({ binaryDirectory: binaryDirectory!, modelDirectory: modelDirectory! })
  const states: SttState[] = []
  adapter.onState(state => states.push(state))
  try {
    await adapter.prepare()
    expect(adapter.getState().status).toBe('ready')
    const track = await fixtureTrack('en-question')
    const segments = await adapter.transcribe(track, 'en', new AbortController().signal)
    const text = segments.map(segment => segment.text).join(' ').toLowerCase()
    expect(text).toContain('process')
    expect(text).toContain('thread')
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.every(segment => segment.source === 'system' && segment.startMs >= 250)).toBe(true)
    // Calling prepare again must retain the same loaded context instead of restarting per request.
    await adapter.prepare()
    expect(states.filter(state => state.status === 'loading')).toHaveLength(1)
    const controller = new AbortController()
    const inference = adapter.transcribe(track, 'en', controller.signal)
    const abort = setTimeout(() => controller.abort(new Error('native_cancel')), 75)
    try { await expect(inference).rejects.toThrow('native_cancel') } finally { clearTimeout(abort) }
    await adapter.prepare()
    expect(adapter.getState().status).toBe('ready')
  } finally { await adapter.dispose() }
}, 120_000)

it.runIf(Boolean(binaryDirectory && modelDirectory))('recognizes a Russian interview question with the multilingual local model', async () => {
  const adapter = new WhisperCppAdapter({ binaryDirectory: binaryDirectory!, modelDirectory: modelDirectory! })
  try {
    const track = await fixtureTrack('ru-question', 'microphone')
    const segments = await adapter.transcribe(track, 'ru', new AbortController().signal)
    const text = segments.map(segment => segment.text).join(' ').toLowerCase()
    expect(text).toMatch(/процесс/)
    expect(text).toMatch(/поток/)
    // Synthetic formant speech can produce a doubled consonant; the negating
    // prefix must still be present, so "синхронность" alone cannot pass.
    expect(text).toMatch(/ас{1,2}инхрон/)
    expect(segments.every(segment => segment.source === 'microphone' && segment.startMs >= 250)).toBe(true)
    expect(adapter.getState().status).toBe('ready')
  } finally { await adapter.dispose() }
}, 120_000)
