import type { AudioSource, CapturedTrack } from '../../domain/types'

export const PCM_SAMPLE_RATE = 16_000 as const
export const PCM_FRAME_SAMPLES = 1_600
export const MAX_PCM_BYTES = PCM_SAMPLE_RATE * 2 * 120

/** Stateful area resampler. Fractional samples survive render-quantum boundaries. */
export class PcmResampler {
  private weighted = 0
  private filled = 0
  private readonly ratio: number

  constructor(inputRate: number, private readonly outputRate = PCM_SAMPLE_RATE) {
    if (!Number.isFinite(inputRate) || inputRate < outputRate) throw new Error('Unsupported sample rate')
    this.ratio = inputRate / outputRate
  }

  push(channels: readonly Float32Array[]): Int16Array {
    if (!channels.length || !channels[0]?.length) return new Int16Array()
    const output: number[] = []
    for (let index = 0; index < channels[0].length; index++) {
      let value = 0
      for (const channel of channels) value += channel[index] || 0
      value /= channels.length
      let remaining = 1
      while (remaining > 1e-9) {
        const amount = Math.min(remaining, this.ratio - this.filled)
        this.weighted += value * amount
        this.filled += amount
        remaining -= amount
        if (this.filled >= this.ratio - 1e-9) {
          const normalized = Math.max(-1, Math.min(1, this.weighted / this.ratio))
          output.push(Math.round(normalized * (normalized < 0 ? 32768 : 32767)))
          this.weighted = 0
          this.filled = 0
        }
      }
    }
    return Int16Array.from(output)
  }
}

export function encodeWav(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength % 2) throw new Error('PCM16 must contain complete samples')
  if (pcm.byteLength > MAX_PCM_BYTES) throw new Error('Recording exceeds 120 seconds')
  const bytes = new Uint8Array(44 + pcm.byteLength)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string): void => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, PCM_SAMPLE_RATE, true)
  view.setUint32(28, PCM_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ascii(36, 'data'); view.setUint32(40, pcm.byteLength, true); bytes.set(pcm, 44)
  return bytes
}

export function pcmLevel(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let sum = 0
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) sum += (view.getInt16(i, true) / 32768) ** 2
  return pcm.byteLength ? Math.sqrt(sum / (pcm.byteLength / 2)) : 0
}

/** Rejects gaps/duplicates so a dropped source cannot become a silently shortened transcript. */
export class TrackAccumulator {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private nextSequence = 0
  private receivedBytes = 0
  private initialOffset?: number

  constructor(readonly source: AudioSource) {}

  append(sequence: number, offsetMs: number, pcm: Uint8Array): void {
    if (!Number.isInteger(sequence) || sequence !== this.nextSequence) throw new Error('Нарушен порядок аудиофрагментов')
    // A flush can arrive one render quantum after the timer; storage still hard-caps at 120 s.
    if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > 121_500) throw new Error('Некорректное время аудиофрагмента')
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > PCM_FRAME_SAMPLES * 2) throw new Error('Некорректный аудиофрагмент')
    this.initialOffset ??= offsetMs
    if (Math.abs(offsetMs - this.initialOffset - this.receivedBytes / 32) > 2) throw new Error('В аудиопотоке обнаружен пропуск')
    this.nextSequence++
    this.receivedBytes += pcm.byteLength
    const remaining = MAX_PCM_BYTES - this.bytes
    if (remaining <= 0) return
    const chunk = pcm.slice(0, remaining)
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
  }

  finish(): CapturedTrack {
    const pcm = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.byteLength }
    this.clear()
    return { source: this.source, pcm, sampleRate: PCM_SAMPLE_RATE, offsetMs: this.initialOffset ?? 0 }
  }

  clear(): void { this.chunks = []; this.bytes = 0 }
}
