import pcmWorkletUrl from './pcm-worklet.ts?worker&url'
import type { CaptureCommand, CaptureMessage } from '../adapters/audio/protocol'
import type { AudioSource } from '../domain/types'

interface SourceGraph { source: AudioSource; stream: MediaStream; input: MediaStreamAudioSourceNode; node: AudioWorkletNode; flush?: () => void }
interface Recording { id: string; streams: MediaStream[]; graphs: SourceGraph[]; context?: AudioContext; timer?: ReturnType<typeof setTimeout>; finishing: boolean }
let port: MessagePort | undefined
let pending: Extract<CaptureCommand, { type: 'arm' }> | undefined
let recording: Recording | undefined
// Electron MessagePortMain accepts ArrayBuffers as cloned payloads, but does not
// receive Blink's transferred ArrayBuffer attachments. Each bounded PCM frame
// is only 3.2 KB; keep transfers on the worklet hop and clone on this main-process hop.
const post = (message: CaptureMessage): void => { port?.postMessage(message) }

function messageOf(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Доступ к аудио не разрешён. Проверьте разрешения микрофона в Windows.'
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'Выбранный микрофон недоступен. Выберите другое устройство.'
    if (error.name === 'NotReadableError') return 'Не удалось открыть аудиоустройство. Проверьте подключение и настройки звука Windows.'
  }
  return error instanceof Error ? error.message : String(error)
}

async function release(run: Recording): Promise<void> {
  if (run.timer) clearTimeout(run.timer)
  for (const stream of run.streams) for (const track of stream.getTracks()) track.stop()
  for (const graph of run.graphs) { graph.input.disconnect(); graph.node.disconnect(); graph.node.port.close() }
  if (run.context?.state !== 'closed') await run.context?.close().catch(() => undefined)
}

async function finish(options: { partial?: boolean; error?: string; cancelled?: boolean } = {}): Promise<void> {
  const run = recording
  if (!run || run.finishing) return
  run.finishing = true
  let flushFailed = false
  if (!options.cancelled) {
    await Promise.all(run.graphs.map(graph => new Promise<void>(resolve => {
      const timer = setTimeout(() => { flushFailed = true; resolve() }, 1500)
      graph.flush = () => { clearTimeout(timer); resolve() }
      graph.node.port.postMessage({ type: 'flush' })
    })))
  }
  await release(run)
  if (recording === run) recording = undefined
  post({ type: 'stopped', recordingId: run.id, partial: options.partial === true || flushFailed, error: options.error ?? (flushFailed ? 'Не удалось получить последний аудиофрагмент' : undefined), cancelled: options.cancelled })
}

async function startPending(): Promise<void> {
  const command = pending
  pending = undefined
  if (!command || recording) throw new Error('Запись уже запущена или не подготовлена')
  const run: Recording = { id: command.recordingId, streams: [], graphs: [], finishing: false }
  recording = run
  const acquire = async (source: AudioSource): Promise<{ source: AudioSource; stream: MediaStream }> => {
    // getDisplayMedia is called synchronously before the first await, within user activation.
    const stream = source === 'system'
      ? await navigator.mediaDevices.getDisplayMedia({ video: { width: 1, height: 1, frameRate: 1 }, audio: true })
      : await navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: command.microphoneId ? { exact: command.microphoneId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
    if (recording !== run || run.finishing) { stream.getTracks().forEach(track => track.stop()); throw new Error('Запись отменена') }
    run.streams.push(stream)
    const audio = stream.getAudioTracks()
    if (!audio.length) throw new Error(source === 'system' ? 'Windows не предоставила системный звук' : 'Микрофон не предоставил аудиодорожку')
    // No screen pixels are processed or retained.
    stream.getVideoTracks().forEach(track => track.stop())
    for (const track of audio) track.addEventListener('ended', () => { if (!run.finishing) void finish({ partial: true, error: source === 'system' ? 'Потерян системный аудиопоток' : 'Микрофон отключён' }) }, { once: true })
    return { source, stream }
  }
  try {
    // Initiate display capture first: its API consumes transient user activation.
    const ordered = [...command.sources].sort(source => source === 'system' ? -1 : 1)
    const outcomes = await Promise.allSettled(ordered.map(acquire))
    const rejected = outcomes.find(result => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    if (recording !== run || run.finishing) return
    const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
    run.context = context
    // Keep the processing clock running without depending on a physical output device.
    // Chromium's silent sink also guarantees that this graph cannot produce audible sound.
    await (context as AudioContext & { setSinkId(sink: { type: 'none' }): Promise<void> }).setSinkId({ type: 'none' })
    await context.audioWorklet.addModule(pcmWorkletUrl)
    if (recording !== run || run.finishing) { await release(run); return }
    const silence = context.createGain()
    silence.gain.value = 0
    silence.connect(context.destination)
    const startTime = context.currentTime
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') continue
      const { source, stream } = outcome.value
      const input = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'interview-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { startTime } })
      const graph: SourceGraph = { source, stream, input, node }
      run.graphs.push(graph)
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'flushed') { graph.flush?.(); return }
        if (event.data?.type !== 'pcm' || recording !== run) return
        const { sequence, offsetMs, pcm, level } = event.data as { sequence: number; offsetMs: number; pcm: ArrayBuffer; level: number }
        post({ type: 'pcm', recordingId: run.id, source, sequence, offsetMs, pcm, level })
      }
      node.onprocessorerror = () => { if (!run.finishing) void finish({ partial: true, error: 'Ошибка обработки аудио' }) }
      input.connect(node)
      node.connect(silence)
    }
    await context.resume()
    if (recording !== run || run.finishing) return
    run.timer = setTimeout(() => { void finish() }, 120_000)
    post({ type: 'started', recordingId: run.id })
  } catch (error) {
    await release(run)
    if (recording === run) recording = undefined
    post({ type: 'error', recordingId: run.id, error: messageOf(error) })
  }
}

Object.defineProperty(window, '__captureStart', { value: startPending, writable: false, configurable: false })

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.data?.type !== 'capture:port' || port || !event.ports[0]) return
  port = event.ports[0]
  port.onmessage = (message: MessageEvent<CaptureCommand>) => {
    const command = message.data
    if (command.type === 'arm') {
      if (recording) { post({ type: 'error', recordingId: command.recordingId, error: 'Запись уже запущена' }); return }
      pending = command
      post({ type: 'armed', recordingId: command.recordingId })
    } else if (command.type === 'cancel') {
      if (pending?.recordingId === command.recordingId) pending = undefined
      if (recording?.id === command.recordingId) void finish({ cancelled: true })
      else post({ type: 'stopped', recordingId: command.recordingId, cancelled: true, partial: false })
    } else if (command.type === 'stop' && recording?.id === command.recordingId) {
      void finish()
    } else if (command.type === 'devices') {
      void navigator.mediaDevices.enumerateDevices().then(devices => post({ type: 'devices', requestId: command.requestId, devices: devices.filter(device => device.kind === 'audioinput').map((device, index) => ({ id: device.deviceId, label: device.label || `Микрофон ${index + 1}` })) })).catch(() => post({ type: 'devices', requestId: command.requestId, devices: [] }))
    }
  }
  port.start()
  post({ type: 'ready' })
}, { once: false })

window.addEventListener('beforeunload', () => { if (recording) void release(recording) })
