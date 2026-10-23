import { describe, expect, it } from 'vitest'
import { encodeWav, MAX_PCM_BYTES, pcmLevel, PcmResampler, TrackAccumulator } from '../src/adapters/audio/pcm'

describe('audio PCM contract', () => {
  it('resamples 44.1 kHz across irregular worklet boundaries without drifting', () => {
    const signal = Float32Array.from({ length: 44_100 }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / 44_100) * 0.5)
    const whole = new PcmResampler(44_100).push([signal])
    const encoder = new PcmResampler(44_100)
    const samples: number[] = []
    for (let offset = 0; offset < signal.length; offset += 128) samples.push(...encoder.push([signal.subarray(offset, offset + 128)]))
    expect(samples).toHaveLength(16_000)
    expect(Int16Array.from(samples)).toEqual(whole)
  })

  it('downmixes channels and clamps signed PCM16', () => {
    const encoder = new PcmResampler(16_000)
    expect([...encoder.push([new Float32Array([2, -2, 0.5]), new Float32Array([2, -2, -0.5])])]).toEqual([32767, -32768, 0])
  })

  it('writes a standalone little endian mono WAV with correct byte lengths', () => {
    const samples = new Int16Array([32767, -32768, 0, 1000])
    const wav = encodeWav(new Uint8Array(samples.buffer))
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(wav.length - 8)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(samples.byteLength)
    expect(view.getInt16(46, true)).toBe(-32768)
  })

  it('rejects truncated sample pairs and oversized utterances', () => {
    expect(() => encodeWav(new Uint8Array(3))).toThrow(/complete samples/)
    expect(() => encodeWav(new Uint8Array(MAX_PCM_BYTES + 2))).toThrow(/120 seconds/)
  })

  it('detects sequence gaps and does not merge source timelines', () => {
    const mic = new TrackAccumulator('microphone')
    const system = new TrackAccumulator('system')
    const frame = new Uint8Array(3200)
    mic.append(0, 12, frame); mic.append(1, 112, frame)
    system.append(0, 0, frame)
    expect(() => system.append(2, 200, frame)).toThrow(/порядок/)
    expect(() => mic.append(2, 300, frame)).toThrow(/пропуск/)
    expect(mic.finish()).toMatchObject({ source: 'microphone', offsetMs: 12, sampleRate: 16000 })
    expect(system.finish().pcm).toHaveLength(3200)
  })

  it('computes silence without mistaking signed samples for unsigned amplitudes', () => {
    expect(pcmLevel(new Uint8Array(3200))).toBe(0)
    expect(pcmLevel(new Uint8Array(new Int16Array([-16384, 16384]).buffer))).toBeCloseTo(0.5)
  })
})
