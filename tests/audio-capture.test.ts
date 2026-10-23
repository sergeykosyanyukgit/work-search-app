import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  commands: [] as Array<Record<string, unknown>>, gestures: [] as boolean[], windows: [] as Array<{ emit(event: string): void }>,
  emit: undefined as undefined | ((message: Record<string, unknown>) => void),
  currentId: '', earlyStop: false
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakePort extends EventEmitter {
    start(): void {}
    close(): void {}
    postMessage(command: Record<string, unknown>): void {
      harness.commands.push(command)
      if (command.type === 'arm') {
        harness.currentId = command.recordingId as string
        queueMicrotask(() => harness.emit?.({ type: 'armed', recordingId: command.recordingId }))
      } else if (command.type === 'stop' || command.type === 'cancel') {
        queueMicrotask(() => harness.emit?.({ type: 'stopped', recordingId: command.recordingId, partial: false, cancelled: command.type === 'cancel' }))
      } else if (command.type === 'devices') {
        queueMicrotask(() => harness.emit?.({ type: 'devices', requestId: command.requestId, devices: [{ id: 'mic-1', label: 'Test microphone' }] }))
      }
    }
  }
  class FakeWindow extends EventEmitter {
    destroyed = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      setWindowOpenHandler: (): void => {},
      postMessage: (_channel: string, _data: unknown, ports: FakePort[]): void => {
        const port = ports[0]!
        harness.emit = data => port.emit('message', { data })
        queueMicrotask(() => harness.emit?.({ type: 'ready' }))
      },
      executeJavaScript: async (_script: string, userGesture: boolean): Promise<void> => {
        harness.gestures.push(userGesture)
        queueMicrotask(() => harness.emit?.({ type: harness.earlyStop ? 'stopped' : 'started', recordingId: harness.currentId, partial: harness.earlyStop, error: harness.earlyStop ? 'source ended early' : undefined }))
      }
    })
    constructor() { super(); harness.windows.push(this) }
    isDestroyed(): boolean { return this.destroyed }
    setContentProtection(): void {}
    async loadURL(): Promise<void> {}
    destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  }
  return {
    BrowserWindow: FakeWindow,
    MessageChannelMain: class { port1 = new FakePort(); port2 = this.port1 },
    session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} }) },
    desktopCapturer: { getSources: async () => [] }, screen: { getPrimaryDisplay: () => ({ id: 1 }) }
  }
})

import { ElectronAudioCapture } from '../src/adapters/audio/electron-audio-capture'

beforeEach(() => { harness.commands = []; harness.gestures = []; harness.windows = []; harness.emit = undefined; harness.currentId = ''; harness.earlyStop = false })
const adapter = (): ElectronAudioCapture => new ElectronAudioCapture({ rendererPath: 'C:/test/capture/index.html', preloadPath: 'C:/test/preload/capture.cjs' })
const packet = (source: 'microphone' | 'system', sequence: number, offsetMs: number): void => {
  harness.emit?.({ type: 'pcm', recordingId: 'recording-1', source, sequence, offsetMs, pcm: new Uint8Array(3200).buffer, level: 0.25 })
}

describe('isolated capture process boundary', () => {
  it('starts only through user activation and assembles independently aligned sources', async () => {
    const capture = adapter()
    const autoStop = vi.fn(); capture.onStopped(autoStop)
    await capture.initialize()
    await capture.start('recording-1', { sources: ['microphone', 'system'], microphoneId: 'chosen' })
    packet('microphone', 0, 12); packet('system', 0, 0); packet('microphone', 1, 112)
    const result = await capture.stop()
    expect(harness.gestures).toEqual([true])
    expect(result.partial).toBe(false)
    expect(result.tracks.map(track => [track.source, track.pcm.byteLength, track.offsetMs])).toEqual([['microphone', 6400, 12], ['system', 3200, 0]])
    expect(autoStop).not.toHaveBeenCalled()
    await capture.dispose()
  })

  it('rejects a lost packet and emits a partial result instead of guessing audio timing', async () => {
    const capture = adapter()
    const stopped = vi.fn(); capture.onStopped(stopped)
    await capture.start('recording-1', { sources: ['microphone'], microphoneId: '' })
    packet('microphone', 0, 0); packet('microphone', 2, 200)
    await Promise.resolve()
    expect(stopped).toHaveBeenCalledWith(expect.objectContaining({ recordingId: 'recording-1', partial: true, error: expect.stringContaining('порядок') }))
    await capture.dispose()
  })

  it('cancellation discards audio and enumeration never activates capture', async () => {
    const capture = adapter()
    const stopped = vi.fn(); capture.onStopped(stopped)
    expect(await capture.microphones()).toEqual([{ id: 'mic-1', label: 'Test microphone' }])
    expect(harness.gestures).toEqual([])
    await capture.start('recording-1', { sources: ['microphone'], microphoneId: '' })
    packet('microphone', 0, 0)
    await capture.cancel()
    expect(stopped).not.toHaveBeenCalled()
    await expect(capture.stop()).rejects.toThrow('Нет активной записи')
    await capture.dispose()
  })

  it('an audio source ending during startup rejects promptly without a phantom completed recording', async () => {
    harness.earlyStop = true
    const capture = adapter()
    const stopped = vi.fn(); capture.onStopped(stopped)
    await expect(capture.start('recording-1', { sources: ['system'], microphoneId: '' })).rejects.toThrow('source ended early')
    expect(stopped).not.toHaveBeenCalled()
    await capture.dispose()
  })
})
