import { PCM_FRAME_SAMPLES, PcmResampler } from '../adapters/audio/pcm'

declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class PcmProcessor extends AudioWorkletProcessor {
  private readonly encoder = new PcmResampler(sampleRate)
  private frame = new Int16Array(PCM_FRAME_SAMPLES)
  private frameLength = 0
  private sent = 0
  private sequence = 0
  private firstTime?: number
  private startTime: number
  private ended = false

  constructor(options?: { processorOptions?: { startTime?: number } }) {
    super()
    this.startTime = options?.processorOptions?.startTime ?? 0
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'flush') {
        this.emitFrame()
        this.ended = true
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }

  private emitFrame(): void {
    if (!this.frameLength) return
    const samples = this.frame.slice(0, this.frameLength)
    let energy = 0
    for (const sample of samples) energy += (sample / 32768) ** 2
    this.port.postMessage({ type: 'pcm', sequence: this.sequence++, offsetMs: Math.max(0, (this.firstTime ?? 0) - this.startTime) * 1000 + this.sent / 16, pcm: samples.buffer, level: Math.sqrt(energy / samples.length) }, [samples.buffer])
    this.sent += this.frameLength
    this.frameLength = 0
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.ended) return false
    const channels = inputs[0]
    if (!channels?.[0]?.length) return true
    this.firstTime ??= currentTime
    const pcm = this.encoder.push(channels)
    for (const sample of pcm) {
      this.frame[this.frameLength++] = sample
      if (this.frameLength === PCM_FRAME_SAMPLES) this.emitFrame()
    }
    return true
  }
}

registerProcessor('interview-pcm', PcmProcessor)
